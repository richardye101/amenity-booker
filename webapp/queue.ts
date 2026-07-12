// Booking queue + scheduled scans. Owns the persistent queue and the 30s ticker
// that launches src/reserve.ts LEAD_MS before each fire time (it prewarms, holds,
// then fires). One at a time (single browser profile); same-time bookings run
// back-to-back. Also owns the periodic availability scan.
import fs from 'fs';
import { QUEUE_FILE, META_FILE } from '../src/config.ts';
import { spawnJob, getActiveId, hasProc } from './jobs.ts';
import { readLog } from './status.ts';
import type { QueueEntry } from '../src/types.ts';

export const LEAD_MS = 10 * 60 * 1000;

export let queue: QueueEntry[] = [];
try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { queue = []; }
export const saveQueue = (): void => { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); } catch { /* ignore */ } };
export const setQueue = (q: QueueEntry[]): void => { queue = q; };

export const bookingDueSoon = (): boolean => queue.some((e) => e.status === 'queued' && e.fireAt <= Date.now() + LEAD_MS + 60000);

// ---- scan spawners ---------------------------------------------------------
export const spawnScan = (reason: string) => spawnJob({ kind: 'scan', prefix: 'scan', script: 'src/scan.ts', args: ['availability'], config: { reason } });
export const spawnReservations = () => spawnJob({ kind: 'reservations', prefix: 'res', script: 'src/scan.ts', args: ['reservations'] });
export const spawnCancel = (id: string, label: string, cfg: Record<string, unknown> = {}) => spawnJob({
  kind: 'cancel', prefix: 'cancel', script: 'src/scan.ts', args: ['cancel'],
  env: { CANCEL_ID: String(id || ''), CANCEL_LABEL: String(label || id || '') },
  config: cfg,
});
export const spawnOccupancy = (amenityId: string | number, amenityName: string | undefined, days: number | undefined) => spawnJob({
  kind: 'occupancy', prefix: 'occ', script: 'src/scan.ts', args: ['occupancy'],
  env: { AMENITY_ID: String(amenityId), AMENITY_NAME: String(amenityName || ''), DAYS: String(days || 14) },
  config: { amenity: amenityId, amenityName, days },
});

// ---- scheduled availability scan ------------------------------------------
// Refreshes webapp/amenities-meta.json on an interval (SCAN_INTERVAL_HOURS,
// default weekly; 0 disables). Skips while a browser session is active.
const SCAN_INTERVAL_H = parseFloat(process.env.SCAN_INTERVAL_HOURS || '168');
function metaAgeHours(): number { try { return (Date.now() - fs.statSync(META_FILE).mtimeMs) / 3.6e6; } catch { return Infinity; } }
export function maybeScan(reason: string): void {
  if (SCAN_INTERVAL_H <= 0) return;
  if (getActiveId() || bookingDueSoon()) { setTimeout(() => maybeScan('retry-after-busy'), 30 * 60 * 1000); return; }
  spawnScan(reason);
}

// ---- ticker ----------------------------------------------------------------
export function reconcileQueue(): void {
  for (const e of queue) {
    if (e.status !== 'running' || (e.runTag && hasProc(e.runTag))) continue;
    const m = readLog(e.runTag || '').match(/RESERVE_RESULT (\{.*\})/);
    if (m) { try { const r = JSON.parse(m[1]); e.status = r.booked ? 'booked' : 'failed'; e.result = r.message; } catch { e.status = 'failed'; } }
    else e.status = e.fireAt > Date.now() ? 'queued' : 'failed'; // crashed before result
  }
  // A booked slot "moves" to My reservations: drop it from the queue and
  // refresh the scrape so it shows up there. (Failed entries stay visible.)
  if (queue.some((e) => e.status === 'booked')) {
    queue = queue.filter((e) => e.status !== 'booked');
    saveQueue();
    if (!getActiveId()) spawnReservations();
    return;
  }
  saveQueue();
}
export function tickQueue(): void {
  reconcileQueue();
  if (getActiveId()) return;
  const due = queue.filter((e) => e.status === 'queued' && e.fireAt <= Date.now() + LEAD_MS).sort((a, b) => a.fireAt - b.fireAt);
  if (!due.length) return;
  const e = due[0];
  const r = spawnJob({ kind: 'booking', prefix: 'fast', script: 'src/reserve.ts', pipe: false, env: { ...e.env, FIRE_AT_MS: String(e.fireAt) }, config: e.config });
  if ('ok' in r) { e.status = 'running'; e.runTag = r.id; saveQueue(); }
}
export function scheduleScans(): void {
  if (SCAN_INTERVAL_H <= 0) { console.log('[scan] scheduled refresh disabled (SCAN_INTERVAL_HOURS=0)'); return; }
  // Refresh on startup only if the data is missing or older than the interval.
  if (metaAgeHours() > SCAN_INTERVAL_H) setTimeout(() => maybeScan('startup-stale'), 8000);
  setInterval(() => maybeScan('scheduled'), SCAN_INTERVAL_H * 3.6e6);
  console.log(`[scan] auto-refresh every ${SCAN_INTERVAL_H}h`);
}
