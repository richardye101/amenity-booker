// Central config: building host, filesystem paths, .env loader, and the small
// file read helpers shared by the webapp and scanners. loadEnv() runs at import
// time (as the old files did) so process.env is populated before anything reads it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AmenityMeta, AmenityMetaMap } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // .../src
export const ROOT = path.join(__dirname, '..');

// Zero-dep .env loader (does not overwrite already-set env vars).
export function loadEnv(): void {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadEnv();

// The building's BuildingLink host. Hardcoded historically in 5 files; override
// via BL_BASE_URL but default to the existing host so behavior is unchanged.
export const BASE_URL = process.env.BL_BASE_URL || 'https://harbourviewresidents.buildinglink.com';
// SSO host used to detect login redirects (separate from the tenant host).
export const AUTH_HOST = 'auth.buildinglink.com';

// Paths.
export const USER_DATA_DIR = path.join(ROOT, 'user-data');
export const RUN_LOGS = path.join(ROOT, 'run-logs');
export const WEBAPP_DIR = path.join(ROOT, 'webapp');
export const META_FILE = path.join(WEBAPP_DIR, 'amenities-meta.json');
export const MY_RES_FILE = path.join(WEBAPP_DIR, 'my-reservations.json');
export const JOBS_FILE = path.join(WEBAPP_DIR, 'jobs.json');
export const QUEUE_FILE = path.join(WEBAPP_DIR, 'queue.json');
export const SESSION_FILE = path.join(WEBAPP_DIR, 'session-status.json');
export const CAPTURE_DIR = path.join(ROOT, 'capture');
export const occupancyFile = (id: string | number): string => path.join(WEBAPP_DIR, `occupancy-${id}.json`);

// ---- shared file read helpers ---------------------------------------------
export function loadMeta(): AmenityMetaMap {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
export function loadMyRes(): { updatedAt: string | null; reservations: unknown[] } {
  try { return JSON.parse(fs.readFileSync(MY_RES_FILE, 'utf8')); } catch { return { updatedAt: null, reservations: [] }; }
}
export function loadOccupancy(id: string | number): unknown | null {
  try { return JSON.parse(fs.readFileSync(occupancyFile(id), 'utf8')); } catch { return null; }
}

// Epoch ms when a target date (Y, MO 0-based, D) becomes bookable, per rule type.
export function openMillisFor(meta: AmenityMeta | undefined | null, Y: number, MO: number, D: number): number | null {
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
