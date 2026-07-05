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
const MY_RES_FILE = path.join(ROOT, 'webapp', 'my-reservations.json');
function loadMeta() { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { return {}; } }
function loadMyRes() { try { return JSON.parse(fs.readFileSync(MY_RES_FILE, 'utf8')); } catch (_) { return { updatedAt: null, reservations: [] }; } }
function loadOccupancy(id) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', `occupancy-${id}.json`), 'utf8')); } catch (_) { return null; } }
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

// ---- session status (is the server's browser profile signed in?) ----------
const SESSION_FILE = path.join(__dirname, 'session-status.json');
let sessionStatus = (() => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (_) { return { state: 'unknown', at: null }; } })();
function setSession(state) {
  sessionStatus = { state, at: new Date().toISOString() };
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionStatus)); } catch (_) {}
}
// Infer sign-in state from a finished browser job's log.
function inferSessionFromLog(runTag) {
  const log = readLog(runTag);
  if (/LOGIN_RESULT [^\n]*"ok":true/.test(log) || /PREWARMED|session live|"booked":true|Wrote [^\n]*amenities-meta|MY_RESERVATIONS|OCCUPANCY_DONE/.test(log)) return 'signed-in';
  if (/LOGIN_RESULT [^\n]*"ok":false/.test(log) || /no \.env creds|please LOG IN|login redirect|session expired/.test(log)) return 'signed-out';
  return null;
}
function onBrowserJobExit(runTag) { const s = inferSessionFromLog(runTag); if (s) setSession(s); }

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
  if (job.kind === 'reservations') phase = /MY_RESERVATIONS/.test(log) ? 'done' : (alive ? 'loading' : 'failed');
  if (job.kind === 'occupancy') phase = /OCCUPANCY_DONE/.test(log) ? 'done' : (alive ? 'scanning' : 'failed');
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

// One launcher for every browser job. Holds the single-browser lock, tracks
// the process, and pipes output to run-logs (except the booking engine, which
// writes its own RUN_TAG log, so it runs pipe:false). macOS: caffeinate -i.
function spawnJob({ kind, prefix, script, env = {}, config = {}, pipe = true }) {
  if (activeId) return { error: 'A browser session is already active. Try again in a moment.' };
  const runTag = `${prefix}-${Date.now()}`;
  const target = path.join(ROOT, script);
  const [cmd, args] = process.platform === 'darwin' ? ['caffeinate', ['-i', 'node', target]] : ['node', [target]];
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env, RUN_TAG: runTag }, stdio: pipe ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
  if (pipe) { const ws = fs.createWriteStream(path.join(RUN_LOGS, `${runTag}.log`)); child.stdout.pipe(ws); child.stderr.pipe(ws); }
  jobs.push({ id: runTag, runTag, kind, config, startedAt: new Date().toISOString() }); saveJobs();
  procs.set(runTag, child); activeId = runTag;
  child.on('exit', () => { if (activeId === runTag) activeId = null; procs.delete(runTag); onBrowserJobExit(runTag); saveJobs(); });
  return { ok: true, id: runTag };
}

// ---- scheduled availability scan ------------------------------------------
// Refreshes webapp/amenities-meta.json on an interval (SCAN_INTERVAL_HOURS,
// default weekly; 0 disables). Skips while a browser session is active.
const SCAN_INTERVAL_H = parseFloat(process.env.SCAN_INTERVAL_HOURS || '168');
function metaAgeHours() { try { return (Date.now() - fs.statSync(META_FILE).mtimeMs) / 3.6e6; } catch (_) { return Infinity; } }
const spawnScan = (reason) => spawnJob({ kind: 'scan', prefix: 'scan', script: 'scan-availability.js', config: { reason } });
const spawnReservations = () => spawnJob({ kind: 'reservations', prefix: 'res', script: 'scan-reservations.js' });
const spawnOccupancy = (amenityId, amenityName, days) => spawnJob({
  kind: 'occupancy', prefix: 'occ', script: 'scan-occupancy.js',
  env: { AMENITY_ID: String(amenityId), AMENITY_NAME: String(amenityName || ''), DAYS: String(days || 14) },
  config: { amenity: amenityId, amenityName, days },
});
function maybeScan(reason) {
  if (SCAN_INTERVAL_H <= 0) return;
  if (activeId || bookingDueSoon()) { setTimeout(() => maybeScan('retry-after-busy'), 30 * 60 * 1000); return; }
  spawnScan(reason);
}

// ---- booking queue --------------------------------------------------------
// Persistent list of scheduled bookings. A ticker launches reserve-fast.js
// LEAD_MS before each fire time (it prewarms, holds, then fires). One at a time
// (single browser profile); same-time bookings run back-to-back.
const QUEUE_FILE = path.join(__dirname, 'queue.json');
const LEAD_MS = 10 * 60 * 1000;
let queue = []; try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch (_) { queue = []; }
const saveQueue = () => { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); } catch (_) {} };
const nextMidnight = () => { const t = new Date(); t.setHours(24, 0, 0, 0); return t.getTime(); };
const bookingDueSoon = () => queue.some((e) => e.status === 'queued' && e.fireAt <= Date.now() + LEAD_MS + 60000);

function reconcileQueue() {
  for (const e of queue) {
    if (e.status !== 'running' || procs.has(e.runTag)) continue;
    const m = readLog(e.runTag).match(/RESERVE_RESULT (\{.*\})/);
    if (m) { try { const r = JSON.parse(m[1]); e.status = r.booked ? 'booked' : 'failed'; e.result = r.message; } catch (_) { e.status = 'failed'; } }
    else e.status = e.fireAt > Date.now() ? 'queued' : 'failed'; // crashed before result
  }
  saveQueue();
}
function tickQueue() {
  reconcileQueue();
  if (activeId) return;
  const due = queue.filter((e) => e.status === 'queued' && e.fireAt <= Date.now() + LEAD_MS).sort((a, b) => a.fireAt - b.fireAt);
  if (!due.length) return;
  const e = due[0];
  const r = spawnJob({ kind: 'booking', prefix: 'fast', script: 'reserve-fast.js', pipe: false, env: { ...e.env, FIRE_AT_MS: String(e.fireAt) }, config: e.config });
  if (r.ok) { e.status = 'running'; e.runTag = r.id; saveQueue(); }
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
    if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' }); return res.end(fs.readFileSync(file)); }
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
    const q = queue.map((e) => ({ id: e.id, fireAt: e.fireAt, status: e.status, result: e.result || null, config: e.config }));
    return send(res, 200, { activeId, session: sessionStatus, queue: q, jobs: list });
  }

  if (p === '/api/reservations/mine' && req.method === 'GET') return send(res, 200, loadMyRes());
  if (p === '/api/reservations/refresh' && req.method === 'POST') {
    const r = spawnReservations();
    return send(res, r.error ? 409 : 200, r);
  }
  if (p === '/api/occupancy' && req.method === 'GET') {
    const id = u.searchParams.get('amenityId');
    return send(res, 200, loadOccupancy(id) || { amenityId: id, days: [] });
  }
  if (p === '/api/occupancy/refresh' && req.method === 'POST') {
    const b = await readBody(req);
    const r = spawnOccupancy(b.amenityId, b.amenityName, b.days);
    return send(res, r.error ? 409 : 200, r);
  }

  // Refresh / verify the server browser's sign-in state (auto-login via .env).
  if ((p === '/api/login' || p === '/api/session/refresh') && req.method === 'POST') {
    const r = spawnJob({ kind: 'login', prefix: 'login', script: 'login.js' });
    if (r.ok) setSession('checking');
    return send(res, r.error ? 409 : 200, r);
  }

  if ((p === '/api/arm' || p === '/api/queue') && req.method === 'POST') {
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
    if (b.dryRun) env.DRY_RUN = '1';

    // Compute the exact fire time; the queue ticker launches reserve-fast ~10
    // min before it (no browser held until then).
    let fireAt;
    if (b.fireMode === 'now') fireAt = Date.now();
    else if (b.fireMode === 'at' && b.fireAt) fireAt = new Date(b.fireAt).getTime();
    else if (b.fireMode === 'auto') { const o = openMillisFor(loadMeta()[String(b.amenityId)], dp.Y, dp.MO, dp.D); fireAt = o != null ? o : nextMidnight(); }
    else fireAt = nextMidnight();
    if (!fireAt || fireAt < Date.now()) fireAt = Date.now();

    queue.push({
      id: 'q' + Date.now(), fireAt, env, status: 'queued', queuedAt: new Date().toISOString(),
      config: { amenity: b.amenityId, amenityName: (AMENITIES.find((a) => a.id === String(b.amenityId)) || {}).name || `#${b.amenityId}`,
        date: dp.title, primary: `${s.display}-${e.display}`, fallback: b.fallbackEnabled ? `${env.FB_START_TIME}-${env.FB_END_TIME}` : null,
        fire: new Date(fireAt).toLocaleString(), dryRun: !!b.dryRun },
    });
    saveQueue(); tickQueue(); // start immediately if it's already within the lead window
    return send(res, 200, { ok: true });
  }

  if (p === '/api/queue' && req.method === 'GET') {
    return send(res, 200, { queue: queue.map((e) => ({ id: e.id, fireAt: e.fireAt, status: e.status, result: e.result || null, config: e.config })) });
  }
  if (p === '/api/queue/remove' && req.method === 'POST') {
    const b = await readBody(req);
    queue = queue.filter((e) => !(e.id === b.id && e.status !== 'running')); // can clear queued/booked/failed, not a running one
    saveQueue();
    return send(res, 200, { ok: true });
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
  setTimeout(tickQueue, 3000);           // resume any queued/interrupted bookings on boot
  setInterval(tickQueue, 30 * 1000);     // launch due bookings ~10 min before fire
});
