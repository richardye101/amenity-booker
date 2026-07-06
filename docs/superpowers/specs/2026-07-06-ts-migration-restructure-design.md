# TypeScript migration + restructure — design

Date: 2026-07-06
Status: approved (design), pending spec review

## Goal

Convert the amenity-booker bot to TypeScript and simplify its structure, without
changing runtime behavior. The booking engine must fire identically; the queue,
timezone, and cancel logic added on 2026-07-06 stay as-is. This is a refactor.

## Non-goals

- No new features. No UI redesign beyond what falls out of the file moves.
- No change to how bookings fire, how the queue schedules, or the deploy loop's
  shape (git pull → restart). We only add a type-check gate to it.
- No rewrite of the Playwright scraping logic — it moves, it doesn't change.

## Runtime decision: native `.ts` on Node 22 (no build step)

Chosen over a `tsc` build or a `tsx` loader. Node 22 runs `.ts` directly via type
stripping. Types are **erased, not checked** at runtime, so correctness relies on
a separate `tsc --noEmit` pass (editor + a pre-deploy gate).

Constraints type-stripping imposes (must follow in all `.ts`):
- No `enum`, no `namespace`, no constructor parameter properties.
- Use `import type` for type-only imports.
- Explicit `.ts` extensions in relative imports.
- ESM (`import`/`export`) throughout — replaces the current `require`/CommonJS.

`tsconfig.json`: `strict`, `noEmit`, `module: nodenext`, `allowImportingTsExtensions`,
`verbatimModuleSyntax`.

## Box upgrade (the risky part)

Current box: `/usr/bin/node` v20.19.2, system-installed, no nvm.

Plan (per user): **replace system Node 20 with Node 22** outright — no nvm layer.
Install Node 22 LTS system-wide via the NodeSource apt repo and remove the old
node 20 package. Needs sudo (user runs the sudo steps). The panel service keeps
`bash -lc …`; `/usr/bin/node` simply becomes 22.

If the installed 22.x still gates type-stripping behind a flag, the service and
`spawnJob` pass `--experimental-strip-types`. Node ≥ 22.18 / 23.6 need no flag —
prefer a NodeSource build that runs `.ts` unflagged.

## Target structure

```
src/
  config.ts      # BASE_URL/host, USER_DATA_DIR, output paths, loadEnv()
  types.ts       # QueueEntry, Job, AmenityMeta, ReserveResult, etc.
  amenities.ts   # amenity list (typed)
  auth.ts        # autoLogin, onAuth              (from bl-login.js)
  browser.ts     # withBrowser(opts, fn): launch persistent ctx, ensure login, teardown
  time.ts        # toDisplay, dateParts, parse/fmt helpers, MONTHS  (de-dupes 4 copies)
  reserve.ts     # booking engine                 (from reserve-fast.js, behavior-frozen)
  login.ts       # interactive headed login       (from login.js)
  scan.ts        # ONE scanner, mode = availability | occupancy | reservations
webapp/
  server.ts      # thin HTTP routing only
  jobs.ts        # job registry: spawnJob, procs, activeId, saveJobs
  queue.ts       # queue, tickQueue, reconcileQueue, scheduleScans
  status.ts      # deriveStatus, inferSessionFromLog, readLog
  public/index.html   # unchanged
```

## Component responsibilities

- **config.ts** — single source for the building host (currently hardcoded in 5
  files) and all filesystem paths. Reads env: `BL_BASE_URL`, `PORT`, `HOST`,
  `TZ`, `SCAN_INTERVAL_HOURS`.
- **browser.ts** — `withBrowser({ headless, viewport }, async (page) => …)`:
  loadEnv, launch persistent context at USER_DATA_DIR, run the callback, always
  close. Absorbs the launch boilerplate repeated in login/reserve/all scanners.
- **scan.ts** — dispatch on `SCAN_MODE` (or argv): `availability` writes
  amenities-meta.json, `occupancy` writes occupancy-<id>.json, `reservations`
  writes my-reservations.json. Each mode is a function sharing browser + auth +
  a small `writeJson` helper.
- **webapp split** — `server.ts` only parses requests and calls into `jobs`,
  `queue`, `status`. `jobs.ts` owns the single-browser lock (`activeId`) and
  child-process tracking. `queue.ts` owns persistence + the 30s ticker.
  `status.ts` owns log-derived status (including the `interrupted` fix).

## Data flow (unchanged)

HTTP `POST /api/queue` → `queue.push` + persist → 30s ticker launches
`node src/reserve.ts` ~10 min before fire (via `jobs.spawnJob`) → reserve arms,
fires at `FIRE_AT_MS`, prints `RESERVE_RESULT` → `queue.reconcile` reads the log
and marks booked/failed. `spawnJob` enforces one browser at a time.

## Deploy changes

- `panel.service`: `ExecStart` runs `node webapp/server.ts` under xvfb (unchanged
  otherwise; `TZ` env stays).
- `spawnJob` spawns `node src/<script>.ts`.
- `auto-deploy.sh`: after pull, run `npx tsc --noEmit`; **abort the restart if it
  fails** (don't deploy a type-broken panel). Keep the existing
  running/imminent-booking defer guard. No build artifacts.
- `package.json`: `"type": "module"`, `scripts.start` → `node webapp/server.ts`,
  add `typecheck: tsc --noEmit`; add `typescript` + `@types/node` as devDeps.

## Testing / verification

- `tsc --noEmit` clean is the primary gate.
- Behavior parity checks on the box (branch deploy, before pointing main at it):
  1. Panel serves, `/api/state` OK.
  2. Queue a far-future dry-run → appears → cancel → gone (the roundtrip already
     used today).
  3. One real scan (`reservations`) writes its JSON.
  4. A dry-run booking armed a few minutes out actually launches ~10 min prior
     and prints `RESERVE_RESULT`.
- Keep a tiny assert self-check for pure logic that moves (time helpers, the
  defer predicate, deriveStatus `interrupted` path).

## Rollback

All work on the `ts-migration` branch. The last `.js`/node-20 commit on `main`
(`84b9f2c`) is the instant code rollback: `git reset --hard 84b9f2c` + restart.
Since node 20 is being removed system-wide, code rollback to `.js` would need
node 20 reinstalled — so **verify Node 22 + `.ts` fully on the branch before
merging** (the branch deploy is the real gate; don't cut over blind).

## Sequencing (for the plan)

1. Tooling: tsconfig, package.json, nvm+node22 on box (verify panel still starts
   from a trivial `server.ts` shim).
2. Leaf modules first: config, types, time, auth, amenities, browser (+ asserts).
3. scan.ts (consolidate 3 scanners) — verify each mode on the box.
4. reserve.ts + login.ts (behavior-frozen) — verify dry-run booking.
5. webapp split: status → jobs → queue → server.
6. Deploy wiring: service ExecStart, spawnJob paths, auto-deploy typecheck gate.
7. Full parity verification on branch, then merge to main.
