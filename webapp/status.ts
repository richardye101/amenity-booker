// Log- and file-derived status. Pure: reads run-logs and the session-status file,
// derives a job's phase, and tracks the browser profile's sign-in state. Knows
// nothing about live child processes — callers pass in whether a job is alive.
import fs from 'fs';
import path from 'path';
import { RUN_LOGS, SESSION_FILE } from '../src/config.ts';
import type { Job, ReserveResult, SessionStatus, DerivedStatus } from '../src/types.ts';

export function readLog(runTag: string): string {
  try { return fs.readFileSync(path.join(RUN_LOGS, `${runTag}.log`), 'utf8'); } catch { return ''; }
}

// ---- session status (is the server's browser profile signed in?) ----------
let sessionStatus: SessionStatus = (() => {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return { state: 'unknown', at: null }; }
})();
export const getSession = (): SessionStatus => sessionStatus;
export function setSession(state: string): void {
  sessionStatus = { state, at: new Date().toISOString() };
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionStatus)); } catch { /* ignore */ }
}
// Infer sign-in state from a finished browser job's log.
export function inferSessionFromLog(runTag: string): string | null {
  const log = readLog(runTag);
  if (/LOGIN_RESULT [^\n]*"ok":true/.test(log) || /PREWARMED|session live|"booked":true|Wrote [^\n]*amenities-meta|MY_RESERVATIONS|OCCUPANCY_DONE|CANCEL_RESULT/.test(log)) return 'signed-in';
  if (/LOGIN_RESULT [^\n]*"ok":false/.test(log) || /no \.env creds|please LOG IN|login redirect|session expired/.test(log)) return 'signed-out';
  return null;
}
export function onBrowserJobExit(runTag: string): void { const s = inferSessionFromLog(runTag); if (s) setSession(s); }

// Derive a job's phase from its log. `alive` = whether its child process is
// still running (caller supplies it; status.ts owns no process state).
export function deriveStatus(job: Job, alive: boolean): DerivedStatus {
  const log = readLog(job.runTag);
  let phase = 'starting';
  if (/RESERVE_RESULT/.test(log)) {
    phase = /"booked":true/.test(log) ? 'booked' : (/LOGIN_RESULT/.test(log) ? 'done' : 'failed');
  } else if (/LOGIN_RESULT .*"ok":true/.test(log)) phase = 'logged-in';
  else if (/\bFIRE\b/.test(log)) phase = 'firing';
  else if (/PREWARMED/.test(log)) phase = 'armed';
  else if (/please LOG IN/.test(log)) phase = 'awaiting-login';
  // A booking that already exited without a RESERVE_RESULT was killed/crashed
  // (e.g. panel restart during warm-hold) — don't keep showing it as 'armed'.
  if (job.kind === 'booking' && !alive && !/RESERVE_RESULT/.test(log)) phase = 'interrupted';
  if (job.kind === 'scan') phase = /Wrote .*amenities-meta/.test(log) ? 'done' : (alive ? 'scanning' : 'failed');
  if (job.kind === 'reservations') phase = /MY_RESERVATIONS/.test(log) ? 'done' : (alive ? 'loading' : 'failed');
  if (job.kind === 'occupancy') phase = /OCCUPANCY_DONE/.test(log) ? 'done' : (alive ? 'scanning' : 'failed');
  if (job.kind === 'cancel') phase = /CANCEL_RESULT.*"cancelled":true/.test(log) ? 'done' : (alive ? 'loading' : 'failed');
  const m = log.match(/RESERVE_RESULT (\{.*\})/);
  let result: ReserveResult | null = null;
  if (m) { try { result = JSON.parse(m[1]); } catch { /* ignore */ } }
  const secs = [...log.matchAll(/armed; (\d+)s to fire/g)];
  const lastCountdown = secs.length ? secs[secs.length - 1][1] + 's' : null;
  return { alive, phase, result, lastCountdown, logTail: log.split('\n').slice(-12).join('\n') };
}
