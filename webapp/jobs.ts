// Job registry: owns the single-browser lock (activeId) and child-process
// tracking (procs), plus the persistent jobs list. spawnJob is the one launcher
// for every browser job — it holds the lock, tracks the process, and pipes
// output to run-logs (except the booking engine, which writes its own RUN_TAG
// log, so it runs pipe:false). macOS: caffeinate -i.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { ROOT, RUN_LOGS, JOBS_FILE } from '../src/config.ts';
import { onBrowserJobExit } from './status.ts';
import type { Job, JobKind } from '../src/types.ts';

fs.mkdirSync(RUN_LOGS, { recursive: true });

export let jobs: Job[] = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { jobs = []; }
export const saveJobs = (): void => { try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch { /* ignore */ } };

const procs = new Map<string, ChildProcess>(); // id -> ChildProcess (live this server run only)
let activeId: string | null = null;            // id of the job/login currently holding the browser

export const getActiveId = (): string | null => activeId;
export const hasProc = (id: string): boolean => procs.has(id);
export const isJobAlive = (id: string): boolean => procs.has(id) && !procs.get(id)!.killed;

// Kill a job's process and release the browser lock if it held it.
export function killJob(id: string): void {
  const c = procs.get(id);
  if (c) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  if (activeId === id) activeId = null;
  procs.delete(id);
}

export interface SpawnOpts {
  kind: JobKind;
  prefix: string;
  script: string;             // repo-relative, e.g. 'src/reserve.ts'
  args?: string[];            // extra argv passed after the script (e.g. scan mode)
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  pipe?: boolean;
}

export function spawnJob({ kind, prefix, script, args = [], env = {}, config = {}, pipe = true }: SpawnOpts):
  { error: string } | { ok: true; id: string } {
  if (activeId) return { error: 'A browser session is already active. Try again in a moment.' };
  const runTag = `${prefix}-${Date.now()}`;
  const target = path.join(ROOT, script);
  const nodeArgs = [target, ...args];
  let cmd: string; let spawnArgs: string[];
  if (process.platform === 'darwin') { cmd = 'caffeinate'; spawnArgs = ['-i', 'node', ...nodeArgs]; }
  else { cmd = 'node'; spawnArgs = nodeArgs; }
  const child = spawn(cmd, spawnArgs, { cwd: ROOT, env: { ...process.env, ...env, RUN_TAG: runTag }, stdio: pipe ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
  if (pipe && child.stdout && child.stderr) { const ws = fs.createWriteStream(path.join(RUN_LOGS, `${runTag}.log`)); child.stdout.pipe(ws); child.stderr.pipe(ws); }
  jobs.push({ id: runTag, runTag, kind, config, startedAt: new Date().toISOString() }); saveJobs();
  procs.set(runTag, child); activeId = runTag;
  child.on('exit', () => { if (activeId === runTag) activeId = null; procs.delete(runTag); onBrowserJobExit(runTag); saveJobs(); });
  return { ok: true, id: runTag };
}
