// Zero-dependency control panel for the BuildingLink booking bot.
// Run:  node webapp/server.ts   then open http://localhost:3000
//
// Thin HTTP routing only. It drives the proven src/reserve.ts engine (and
// src/login.ts / src/scan.ts) as child processes via jobs/queue/status, which
// track one active browser session at a time (the login profile can only be
// used by one browser at once).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { WEBAPP_DIR, RUN_LOGS, loadMeta, loadMyRes, loadOccupancy, openMillisFor } from '../src/config.ts';
import { AMENITIES } from '../src/amenities.ts';
import { jobs, getActiveId, isJobAlive, killJob, spawnJob } from './jobs.ts';
import { queue, setQueue, saveQueue, tickQueue, scheduleScans, spawnReservations, spawnOccupancy } from './queue.ts';
import { deriveStatus, getSession, setSession } from './status.ts';

const PORT = Number(process.env.PORT) || 3000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ---- request/response helpers ---------------------------------------------
function toDisplay(hhmm: string): { display: string; hour24: number } {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return { display: `${h12}:${String(m).padStart(2, '0')} ${ap}`, hour24: h };
}
function dateParts(iso: string): { Y: number; MO: number; D: number; title: string } {
  const [Y, M, D] = iso.split('-').map(Number);
  return { Y, MO: M - 1, D, title: `${MONTHS[M - 1]} ${String(D).padStart(2, '0')}, ${Y}` };
}
function send(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
const nextMidnight = (): number => { const t = new Date(); t.setHours(24, 0, 0, 0); return t.getTime(); };

// ---- HTTP -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = u.pathname;

  // static index
  if (p === '/' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(WEBAPP_DIR, 'public', 'index.html'));
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
      const st = deriveStatus(j, isJobAlive(j.id));
      return { ...j, status: st.phase, alive: st.alive, result: st.result, lastCountdown: st.lastCountdown, logTail: st.logTail };
    });
    const q = queue.map((e) => ({ id: e.id, fireAt: e.fireAt, status: e.status, result: e.result || null, config: e.config }));
    return send(res, 200, { activeId: getActiveId(), session: getSession(), queue: q, jobs: list });
  }

  if (p === '/api/reservations/mine' && req.method === 'GET') return send(res, 200, loadMyRes());
  if (p === '/api/reservations/refresh' && req.method === 'POST') {
    const r = spawnReservations();
    return send(res, 'error' in r ? 409 : 200, r);
  }
  if (p === '/api/occupancy' && req.method === 'GET') {
    const id = u.searchParams.get('amenityId');
    return send(res, 200, loadOccupancy(id || '') || { amenityId: id, days: [] });
  }
  if (p === '/api/occupancy/refresh' && req.method === 'POST') {
    const b = await readBody(req);
    const r = spawnOccupancy(b.amenityId, b.amenityName, b.days);
    return send(res, 'error' in r ? 409 : 200, r);
  }

  // Refresh / verify the server browser's sign-in state (auto-login via .env).
  if ((p === '/api/login' || p === '/api/session/refresh') && req.method === 'POST') {
    const r = spawnJob({ kind: 'login', prefix: 'login', script: 'src/login.ts' });
    if ('ok' in r) setSession('checking');
    return send(res, 'error' in r ? 409 : 200, r);
  }

  if ((p === '/api/arm' || p === '/api/queue') && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.amenityId || !b.date || !b.start || !b.end) return send(res, 400, { error: 'amenityId, date, start, end required' });
    const dp = dateParts(b.date);
    const s = toDisplay(b.start), e = toDisplay(b.end);
    const env: Record<string, string> = {
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

    // Compute the exact fire time; the queue ticker launches reserve ~10 min
    // before it (no browser held until then).
    let fireAt;
    if (b.fireMode === 'now') fireAt = Date.now();
    else if (b.fireMode === 'at' && b.fireAt) fireAt = new Date(b.fireAt).getTime();
    else if (b.fireMode === 'auto') { const o = openMillisFor(loadMeta()[String(b.amenityId)], dp.Y, dp.MO, dp.D); fireAt = o != null ? o : nextMidnight(); }
    else fireAt = nextMidnight();
    if (!fireAt || fireAt < Date.now()) fireAt = Date.now();

    queue.push({
      id: 'q' + Date.now(), fireAt, env, status: 'queued', queuedAt: new Date().toISOString(),
      config: { amenity: b.amenityId, amenityName: (AMENITIES.find((a) => a.id === String(b.amenityId)) || {} as any).name || `#${b.amenityId}`,
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
    const e = queue.find((x) => x.id === b.id);
    if (e && e.status === 'running' && e.runTag) { // cancel a firing booking: kill its browser, then drop it
      killJob(e.runTag);
    }
    setQueue(queue.filter((x) => x.id !== b.id));
    saveQueue();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/stop' && req.method === 'POST') {
    const b = await readBody(req);
    const id = b.id || getActiveId();
    if (id) killJob(id);
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
