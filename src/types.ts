// Shared types for the BuildingLink booking bot.

export interface Amenity {
  id: string;
  name: string;
}

// Booking-window metadata scraped per amenity (webapp/amenities-meta.json).
export interface AmenityMeta {
  name: string;
  ruleType?: 'fixed' | 'week' | 'unknown';
  offsetDays?: number | null;
  opensRule: string;
  ruleLabel?: string | null;
  advanceText?: string | null;
  hours?: string | null;
  duration?: string | null;
  adEnd?: number[] | null;
  scrapedOn?: string;
  windowDays?: number | null;
  error?: string;
}

export type AmenityMetaMap = Record<string, AmenityMeta>;

// Result printed by the reserve engine as `RESERVE_RESULT {...}`.
export interface ReserveResult {
  booked: boolean;
  message: string;
}

export type JobKind = 'booking' | 'scan' | 'reservations' | 'occupancy' | 'login';

export interface Job {
  id: string;
  runTag: string;
  kind: JobKind;
  config: Record<string, unknown>;
  startedAt: string;
}

export type QueueStatus = 'queued' | 'running' | 'booked' | 'failed';

export interface QueueConfig {
  amenity: string | number;
  amenityName?: string;
  date?: string;
  primary?: string;
  fallback?: string | null;
  fire?: string;
  dryRun?: boolean;
  reason?: string;
  days?: number;
  [key: string]: unknown;
}

export interface QueueEntry {
  id: string;
  fireAt: number;
  env: Record<string, string>;
  status: QueueStatus;
  queuedAt: string;
  config: QueueConfig;
  runTag?: string;
  result?: string;
}

export interface SessionStatus {
  state: string;
  at: string | null;
}

// Derived, per-job status for the /api/state view.
export interface DerivedStatus {
  alive: boolean;
  phase: string;
  result: ReserveResult | null;
  lastCountdown: string | null;
  logTail: string;
}
