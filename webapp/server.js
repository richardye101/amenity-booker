// Zero-dependency control panel for the BuildingLink booking bot.
// Run:  node webapp/server.js   then open http://localhost:3000
//
// It drives the proven ../reserve-fast.js engine (and ../login.js) as child
// processes, tracking one active browser session at a time (the login profile
// can only be used by one browser at once).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const RUN_LOGS = path.join(ROOT, 'run-logs');
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const PORT = process.env.PORT || 3000;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// All amenities (shared module). Users can also enter a custom ID.
const AMENITIES = require(path.join(ROOT, 'amenities'));
const META_FILE = path.join(ROOT, 'webapp', 'amenities-meta.json');
function loadMeta() { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { return {}; } }
// Epoch ms when target date (Y, MO 0-based, D) becomes bookable, per rule type.
function openMillisFor(meta, Y, MO, D) {
  if (!meta) return null;
  if (meta.ruleType === 'fixed' && typeof meta.offsetDays === 'number') {
    return new Date(Y, MO, D - meta.offsetDays, 0, 0, 0, 0).getTime();
  }
  if (meta.ruleType === 'week') { // whole Sun-Sat week opens Sunday 00:00
    const dow = new Date(Y, MO, D).getDay();
    return new Date(Y, MO, D - dow, 0, 0, 0, 0).getTime();
  }
  return null;
}

fs.mkdirSync(RUN_LOGS, { recursive: true });

// ---- job registry ---------------------------------------------------------
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch (_) { jobs = []; }
const saveJobs = () => { try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch (_) {} };
const procs = new Map(); // id -> ChildProcess (live this server run only)
let activeId = null;      // id of the job/login currently holding the browser

function readLog(runTag) {
  try { return fs.readFileSync(path.join(RUN_LOGS, `${runTag}.log`), 'utf8'); } catch (_) { return ''; }
}
function deriveStatus(job) {
  const alive = procs.has(job.id) && !procs.get(job.id).killed;
  const log = readLog(job.runTag);
  let phase = 'starting';
  if (/RESERVE_RESULT/.test(log)) {
    phase = /"booked":true/.test(log) ? 'booked' : (/LOGIN_RESULT/.test(log) ? 'done' : 'failed');
  } else if (/LOGIN_RESULT .*"ok":true/.test(log)) phase = 'logged-in';
  else if (/\bFIRE\b/.test(log)) phase = 'firing';
  else if (/PREWARMED/.test(log)) phase = 'armed';
  else if (/please LOG IN/.test(log)) phase = 'awaiting-login';
  if (job.kind === 'scan') phase = /Wrote .*amenities-meta/.test(log) ? 'done' : (alive ? 'scanning' : 'failed');
  const m = log.match(/RESERVE_RESULT (\{.*\})/);
  let result = null;
  if (m) { try { result = JSON.parse(m[1]); } catch (_) {} }
  const secs = log.match(/armed; (\d+)s to fire/g);
  const lastCountdown = secs && secs.length ? secs[secs.length - 1] : null;
  return { alive, phase, result, lastCountdown, logTail: log.split('\n').slice(-12).join('\n') };
}
function latestShot(runTag) {
  try {
    const files = fs.readdirSync(RUN_LOGS)
      .filter((f) => f.startsWith(runTag + '-') && f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(RUN_LOGS, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f : null;
  } catch (_) { return null; }
}

// ---- helpers --------------------------------------------------------------
function toDisplay(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return { display: `${h12}:${String(m).padStart(2, '0')} ${ap}`, hour24: h };
}
function dateParts(iso) {
  const [Y, M, D] = iso.split('-').map(Number);
  return { Y, MO: M - 1, D, title: `${MONTHS[M - 1]} ${String(D).padStart(2, '0')}, ${Y}` };
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
  });
}

function spawnEngine(env, runTag, logLabel) {
  const enginePath = path.join(ROOT, 'reserve-fast.js');
  // On macOS, wrap in `caffeinate -i` so the Mac won't idle-sleep while waiting.
  const isMac = process.platform === 'darwin';
  const cmd = isMac ? 'caffeinate' : 'node';
  const args = isMac ? ['-i', 'node', enginePath] : [enginePath];
  const child = spawn(cmd, args, {
    cwd: ROOT, env: { ...process.env, ...env, RUN_TAG: runTag }, stdio: 'ignore',
  });
  child.on('exit', () => { if (activeId && procs.get(activeId) === child) activeId = null; procs.delete(logLabel); saveJobs(); });
  return child;
}

// ---- scheduled availability scan ------------------------------------------
// Refreshes webapp/amenities-meta.json on an interval (SCAN_INTERVAL_HOURS,
// default weekly; 0 disables). Skips while a browser session is active.
const SCAN_INTERVAL_H = parseFloat(process.env.SCAN_INTERVAL_HOURS || '168');
function metaAgeHours() { try { return (Date.now() - fs.statSync(META_FILE).mtimeMs) / 3.6e6; } catch (_) { return Infinity; } }
function spawnScan(reason) {
  const runTag = 'scan-' + Date.now();
  const isMac = process.platform === 'darwin';
  const scan = path.join(ROOT, 'scan-availability.js');
  const child = spawn(isMac ? 'caffeinate' : 'node', isMac ? ['-i', 'node', scan] : [scan], {
    cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ws = fs.createWriteStream(path.join(RUN_LOGS, `${runTag}.log`));
  child.stdout.pipe(ws); child.stderr.pipe(ws);
  const job = { id: runTag, runTag, kind: 'scan', config: { reason }, startedAt: new Date().toISOString() };
  jobs.push(job); saveJobs();
  procs.set(runTag, child); activeId = runTag;
  child.on('exit', () => { if (activeId === runTag) activeId = null; procs.delete(runTag); });
  console.log(`[scan] started (${reason})`);
}
function maybeScan(reason) {
  if (SCAN_INTERVAL_H <= 0) return;
  if (activeId) { setTimeout(() => maybeScan('retry-after-busy'), 30 * 60 * 1000); return; } // profile busy → retry in 30m
  spawnScan(reason);
}
function scheduleScans() {
  if (SCAN_INTERVAL_H <= 0) { console.log('[scan] scheduled refresh disabled (SCAN_INTERVAL_HOURS=0)'); return; }
  // Refresh on startup only if the data is missing or older than the interval.
  if (metaAgeHours() > SCAN_INTERVAL_H) setTimeout(() => maybeScan('startup-stale'), 8000);
  setInterval(() => maybeScan('scheduled'), SCAN_INTERVAL_H * 3.6e6);
  console.log(`[scan] auto-refresh every ${SCAN_INTERVAL_H}h`);
}

// ---- HTTP -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  // static index
  if (p === '/' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // serve screenshots
  if (p.startsWith('/shot/') && req.method === 'GET') {
    const file = path.join(RUN_LOGS, path.basename(p.slice(6)));
    if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(file)); }
    res.writeHead(404); return res.end('no shot');
  }

  if (p === '/api/amenities' && req.method === 'GET') {
    const meta = loadMeta();
    return send(res, 200, { amenities: AMENITIES.map((a) => ({ ...a, meta: meta[a.id] || null })) });
  }

  if (p === '/api/state' && req.method === 'GET') {
    const list = jobs.slice(-15).reverse().map((j) => {
      const st = deriveStatus(j);
      return { ...j, status: st.phase, alive: st.alive, result: st.result, lastCountdown: st.lastCountdown, logTail: st.logTail, shot: latestShot(j.runTag) };
    });
    return send(res, 200, { activeId, jobs: list });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (activeId) return send(res, 409, { error: 'A browser session is already active. Stop it first.' });
    const runTag = 'login-' + Date.now();
    const child = spawn('node', [path.join(ROOT, 'login.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const logPath = path.join(RUN_LOGS, `${runTag}.log`);
    const ws = fs.createWriteStream(logPath);
    child.stdout.pipe(ws); child.stderr.pipe(ws);
    const job = { id: runTag, runTag, kind: 'login', config: {}, startedAt: new Date().toISOString() };
    jobs.push(job); saveJobs();
    procs.set(runTag, child); activeId = runTag;
    child.on('exit', () => { if (activeId === runTag) activeId = null; procs.delete(runTag); });
    return send(res, 200, { ok: true, id: runTag });
  }

  if (p === '/api/arm' && req.method === 'POST') {
    if (activeId) return send(res, 409, { error: 'A browser session is already active (the login profile allows one at a time). Stop it first.' });
    const b = await readBody(req);
    if (!b.amenityId || !b.date || !b.start || !b.end) return send(res, 400, { error: 'amenityId, date, start, end required' });
    const dp = dateParts(b.date);
    const s = toDisplay(b.start), e = toDisplay(b.end);
    const env = {
      AMENITY_ID: String(b.amenityId),
      TARGET_TITLE: dp.title, Y: String(dp.Y), MO: String(dp.MO), D: String(dp.D),
      START_TIME: s.display, END_TIME: e.display, START_H: String(s.hour24), END_H: String(e.hour24),
    };
    if (b.fallbackEnabled && b.fbStart && b.fbEnd) {
      const fs2 = toDisplay(b.fbStart), fe = toDisplay(b.fbEnd);
      env.FB_START_TIME = fs2.display; env.FB_END_TIME = fe.display; env.FB_START_H = String(fs2.hour24); env.FB_END_H = String(fe.hour24);
    } else {
      // No fallback: make it identical to primary so a failed primary just reports.
      env.FB_START_TIME = s.display; env.FB_END_TIME = e.display; env.FB_START_H = String(s.hour24); env.FB_END_H = String(e.hour24);
    }
    if (b.fireMode === 'now') env.FIRE_AT_MS = String(Date.now() + 2000);
    else if (b.fireMode === 'at' && b.fireAt) env.FIRE_AT_MS = String(new Date(b.fireAt).getTime());
    else if (b.fireMode === 'auto') {
      // Compute the exact open moment from the amenity's booking-window rule.
      const open = openMillisFor(loadMeta()[String(b.amenityId)], dp.Y, dp.MO, dp.D);
      if (open !== null) env.FIRE_AT_MS = String(open <= Date.now() ? Date.now() + 2000 : open);
      // if rule unknown, fall through to engine default (next midnight)
    }
    // else 'midnight': engine default = next local midnight
    if (b.dryRun) env.DRY_RUN = '1';

    const runTag = 'fast-' + Date.now();
    const child = spawnEngine(env, runTag, runTag);
    const job = {
      id: runTag, runTag, kind: 'booking',
      config: { amenity: b.amenityId, amenityName: (AMENITIES.find((a) => a.id === String(b.amenityId)) || {}).name || `#${b.amenityId}`,
        date: dp.title, primary: `${s.display}-${e.display}`, fallback: b.fallbackEnabled ? `${env.FB_START_TIME}-${env.FB_END_TIME}` : null,
        fire: env.FIRE_AT_MS ? new Date(Number(env.FIRE_AT_MS)).toLocaleString() : 'next midnight', dryRun: !!b.dryRun },
      startedAt: new Date().toISOString(),
    };
    jobs.push(job); saveJobs();
    procs.set(runTag, child); activeId = runTag;
    return send(res, 200, { ok: true, id: runTag });
  }

  if (p === '/api/stop' && req.method === 'POST') {
    const b = await readBody(req);
    const id = b.id || activeId;
    const c = procs.get(id);
    if (c) { try { c.kill('SIGTERM'); } catch (_) {} }
    if (activeId === id) activeId = null;
    procs.delete(id);
    return send(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('not found');
});

// HOST=127.0.0.1 binds localhost only (reach it via SSH tunnel); default = all interfaces.
const HOST = process.env.HOST || undefined;
server.listen(PORT, HOST, () => {
  console.log(`\n  BuildingLink booking panel → http://${HOST || 'localhost'}:${PORT}${HOST ? '' : '  (all interfaces)'}\n`);
  scheduleScans();
});
