// BuildingLink Tennis Court FAST reservation bot, with a fallback slot.
//
// Opens ONE headed browser now, confirms the session, holds the reservation
// page warm, and at the target instant (default next local midnight) reloads
// until the target date is bookable, then books the PRIMARY slot. If the
// primary Save fails (slot taken / rejected), it immediately tries the
// FALLBACK slot in the same warm window. Sequential -> no double-booking.
//
// Env: TARGET_TITLE, Y/MO/D, START_TIME/END_TIME/START_H/END_H (primary),
//      FB_START_TIME/FB_END_TIME/FB_START_H/FB_END_H (fallback),
//      FIRE_AT_MS, DRY_RUN=1, HEADLESS=1.

import { chromium } from 'playwright';
import type { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { loadEnv, BASE_URL, USER_DATA_DIR, RUN_LOGS as LOG_DIR } from './config.ts';
import { autoLogin } from './auth.ts';
import type { ReserveResult } from './types.ts';
loadEnv();

const AMENITY_ID = process.env.AMENITY_ID || '29916';
const RES_URL =
  `${BASE_URL}/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${AMENITY_ID}&from=0&selectedDate=`;

function nextMidnightMs(): number {
  const t = new Date();
  t.setHours(24, 0, 0, 0);
  return t.getTime();
}

const CFG = {
  targetTitle: process.env.TARGET_TITLE || 'July 04, 2026',
  Y: parseInt(process.env.Y || '2026', 10),
  MO: parseInt(process.env.MO || '6', 10),
  D: parseInt(process.env.D || '4', 10),
  fireAt: process.env.FIRE_AT_MS ? parseInt(process.env.FIRE_AT_MS, 10) : nextMidnightMs(),
  dryRun: process.env.DRY_RUN === '1',
  headless: process.env.HEADLESS === '1',
};
interface Slot { label: string; startTime: string; endTime: string; startH: number; endH: number; }
const START = process.env.START_TIME || '9:00 AM';
const END = process.env.END_TIME || '10:00 AM';
const FB_START = process.env.FB_START_TIME || '10:00 AM';
const FB_END = process.env.FB_END_TIME || '11:00 AM';
const PRIMARY: Slot = {
  label: `primary ${START}–${END}`,
  startTime: START, endTime: END,
  startH: parseInt(process.env.START_H || '9', 10),
  endH: parseInt(process.env.END_H || '10', 10),
};
const FALLBACK: Slot = {
  label: `fallback ${FB_START}–${FB_END}`,
  startTime: FB_START, endTime: FB_END,
  startH: parseInt(process.env.FB_START_H || '10', 10),
  endH: parseInt(process.env.FB_END_H || '11', 10),
};

// PARALLEL>1 races N tabs for the same slot at fire (first to commit wins;
// a losing tab may also commit under BuildingLink's own race — self-double-book
// is accepted). Defaults to 1 (single attempt, unchanged behavior).
const PARALLEL = Math.max(1, parseInt(process.env.PARALLEL || '1', 10));

const IDS = {
  startTimePicker: 'ctl00_ContentPlaceHolder1_StartTimePicker',
  endTimePicker: 'ctl00_ContentPlaceHolder1_EndTimePicker',
  startTimeInput: '#ctl00_ContentPlaceHolder1_StartTimePicker_dateInput',
  endTimeInput: '#ctl00_ContentPlaceHolder1_EndTimePicker_dateInput',
  agreeCheckbox: '#ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox',
  footerSave: '#ctl00_ContentPlaceHolder1_FooterSaveButton',
};

fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const runTag = process.env.RUN_TAG || ('fast-' + stamp());
const logFile = path.join(LOG_DIR, `${runTag}.log`);
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shot(page: Page, name: string): Promise<void> {
  const p = path.join(LOG_DIR, `${runTag}-${name}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  log(`screenshot: ${p}`);
}
const norm = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase();
const dateCellSel = `td[title*="${CFG.targetTitle}"] a`;
const onLogin = (url: string) => /auth\.buildinglink\.com/i.test(url);
const onResPage = (url: string) => /NewReservation\.aspx/i.test(new URL(url).pathname);

// Reload/click until the target date cell is bookable, then select it.
async function ensureDateSelected(page: Page): Promise<void> {
  await page.goto(RES_URL, { waitUntil: 'domcontentloaded' });
  if (onLogin(page.url())) throw new Error('session expired (login redirect)');
  await page.waitForSelector(IDS.agreeCheckbox, { timeout: 20000 }).catch(() => {});
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator(dateCellSel).first().click(),
  ]);
  await page.locator(IDS.startTimeInput).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
}

// Fill times + waiver, verify, and Save. Returns {booked, message}.
async function fillAndSave(page: Page, slot: Slot, tag = ''): Promise<ReserveResult> {
  const L = tag ? `${tag} ` : '';
  log(`${L}${slot.label}: setting times ${slot.startTime}-${slot.endTime}`);
  // NB: do NOT set these via the Telerik widget's set_selectedDate — under
  // Playwright's strict-mode evaluate it throws (MS AJAX touches
  // arguments.callee) AFTER visually setting the start box but WITHOUT a
  // committed postback. That fools the "already correct?" check below into
  // skipping the real fill, and the end fill's postback then resets start to
  // the amenity's opening time (the 9AM/7AM/6AM bug). Fill start first, let its
  // postback settle, then fill end.
  const readV = async () => ({
    start: await page.locator(IDS.startTimeInput).inputValue().catch(() => ''),
    end: await page.locator(IDS.endTimeInput).inputValue().catch(() => ''),
  });
  const fill = async (input: string, want: string): Promise<void> => {
    await page.locator(input).click();
    await page.locator(input).fill(want).catch(() => {});
    await page.locator(input).press('Enter').catch(() => {});
  };
  // Poll cond() every 60ms until true or timeout — condition-based instead of a
  // fixed sleep, so we proceed the instant the postback lands (usually well
  // under the old 500ms) but still wait it out when the server is slow.
  const waitUntil = async (cond: () => Promise<boolean>, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    do { if (await cond().catch(() => false)) return true; await sleep(60); } while (Date.now() < deadline);
    return false;
  };
  // Fill start first; its postback rewrites the end field, so wait until start
  // reads back correct AND end has moved (postback committed) before touching
  // end — filling end before start commits is what let the postback reset start
  // to the opening time (the 9AM/7AM/6AM bug). Retry the pair up to 3×; the
  // verify gate below still blocks a wrong Save either way.
  let v = await readV();
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (norm(v.start) !== norm(slot.startTime)) {
      const endBefore = v.end;
      await fill(IDS.startTimeInput, slot.startTime);
      await waitUntil(async () => { const r = await readV(); return norm(r.start) === norm(slot.startTime) && r.end !== endBefore; }, 3000);
    }
    v = await readV();
    if (norm(v.end) !== norm(slot.endTime)) {
      await fill(IDS.endTimeInput, slot.endTime);
      await waitUntil(async () => norm((await readV()).end) === norm(slot.endTime), 3000);
    }
    v = await readV();
    if (norm(v.start) === norm(slot.startTime) && norm(v.end) === norm(slot.endTime)) break;
    log(`${L}${slot.label}: fields not settled (attempt ${attempt}) start="${v.start}" end="${v.end}"`);
  }
  await page.locator(IDS.agreeCheckbox).check({ force: true });
  v = await readV();
  const checked = await page.locator(IDS.agreeCheckbox).isChecked().catch(() => false);
  const startOK = norm(v.start) === norm(slot.startTime);
  const endOK = norm(v.end) === norm(slot.endTime);
  log(`${L}${slot.label}: VERIFY start="${v.start}"(${startOK}) end="${v.end}"(${endOK}) agreed=${checked}`);
  await shot(page, `${tag}${slot.startH}-filled`);
  if (!startOK || !endOK || !checked) return { booked: false, message: `verify failed for ${slot.label}` };

  if (CFG.dryRun) return { booked: true, message: `DRY RUN ${slot.label} (not saved)` };

  log(`${L}${slot.label}: clicking Save...`);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator(IDS.footerSave).click(),
  ]);
  // Fixed settle before judging. A successful Save does a full redirect OFF
  // NewReservation.aspx (to the calendar), but the redirect can lag the click
  // by a couple seconds under load — read too early and a real booking looks
  // like it "stayed on form". This 4s wait is the proven-reliable behavior;
  // condition-based shortcuts here read mid-postback and false-negatived
  // genuine bookings. Do NOT trim it.
  await page.waitForTimeout(4000);
  await shot(page, `${tag}${slot.startH}-after-save`);
  const url = page.url();
  const booked = !/NewReservation\.aspx/i.test(url);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const errSnip = (bodyText.match(/correct the following error\(s\):([\s\S]{0,160})/i) || ['', ''])[1].replace(/\s+/g, ' ').trim();
  log(`${L}${slot.label}: after-save url=${url} booked=${booked} error="${errSnip}"`);
  return { booked, message: booked ? `BOOKED ${slot.label}` : `NOT booked ${slot.label}: ${errSnip || 'stayed on form'}` };
}

// One independent booking attempt on its own tab: reload-poll until the target
// date is bookable, select it, then PRIMARY (and FALLBACK if it fails). Several
// of these run concurrently when PARALLEL>1. `tag` distinguishes their logs.
async function fireAndBook(page: Page, tag: string): Promise<ReserveResult> {
  const L = tag ? `${tag} ` : '';
  const fireDeadline = Date.now() + 45000;
  let ready = false, n = 0;
  while (Date.now() < fireDeadline) {
    n++;
    await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (onLogin(page.url())) {
      await autoLogin(page, log);
      await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (onLogin(page.url())) throw new Error('login redirect during fire (auto-login failed / no creds)');
    }
    if ((await page.locator(dateCellSel).first().count().catch(() => 0)) > 0) {
      ready = true;
      log(`${L}reload #${n}: "${CFG.targetTitle}" bookable (+${Date.now() - CFG.fireAt}ms).`);
      break;
    }
    await sleep(120);
  }
  if (!ready) throw new Error(`"${CFG.targetTitle}" never became bookable within 45s`);

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator(dateCellSel).first().click(),
  ]);
  await page.locator(IDS.startTimeInput).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  let r = await fillAndSave(page, PRIMARY, tag);
  log(`${L}PRIMARY result: ` + r.message);
  if (!r.booked) {
    log(`${L}primary did not book; trying fallback slot...`);
    await ensureDateSelected(page);
    r = await fillAndSave(page, FALLBACK, tag);
    log(`${L}FALLBACK result: ` + r.message);
  }
  return r;
}

async function run(): Promise<void> {
  log(`START reserve-fast (with fallback). dryRun=${CFG.dryRun} target="${CFG.targetTitle}" primary=${PRIMARY.startTime}-${PRIMARY.endTime} fallback=${FALLBACK.startTime}-${FALLBACK.endTime}`);
  log(`fire at: ${new Date(CFG.fireAt).toString()} (${Math.round((CFG.fireAt - Date.now()) / 1000)}s from now)`);
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: CFG.headless, viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);
  const result: ReserveResult = { booked: false, message: '' };

  try {
    // PREWARM
    log('prewarming...');
    await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto: ' + e.message));
    const loginDeadline = Date.now() + 6 * 60 * 1000;
    let autoTries = 0;
    while (!onResPage(page.url())) {
      if (Date.now() > loginDeadline) throw new Error('not logged in in time');
      if (onLogin(page.url())) {
        if (autoTries < 3) { autoTries++; const r = await autoLogin(page, log); if (r === 'no-creds') log('>> no .env creds — please LOG IN in the browser window...'); }
        else log('>> please LOG IN in the browser window...');
      }
      await sleep(2500);
      if (!onResPage(page.url()) && !onLogin(page.url())) await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForSelector(IDS.agreeCheckbox, { timeout: 20000 }).catch(() => {});
    log('PREWARMED: session live.');
    await shot(page, '0-prewarmed');

    // WAIT until just before fire, with periodic keepalives
    let lastKeepalive = Date.now();
    while (Date.now() < CFG.fireAt - 8000) {
      const secs = Math.round((CFG.fireAt - Date.now()) / 1000);
      if (secs % 30 === 0) log(`armed; ${secs}s to fire...`);
      if (Date.now() - lastKeepalive > 4 * 60 * 1000 && Date.now() < CFG.fireAt - 20000) {
        lastKeepalive = Date.now();
        log('periodic keepalive reload...');
        await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        if (onLogin(page.url())) {
          log('session lapsed during wait; attempting auto-login...');
          await autoLogin(page, log);
          await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          if (onLogin(page.url())) throw new Error('session expired during wait (auto-login failed / no creds)');
        }
      }
      await sleep(1000);
    }
    if (Date.now() < CFG.fireAt - 3000) {
      log('keepalive reload just before fire...');
      await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (onLogin(page.url())) {
        await autoLogin(page, log);
        await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        if (onLogin(page.url())) throw new Error('session expired just before fire (auto-login failed / no creds)');
      }
    }
    // Prewarm extra tabs for parallel attempts — they share the context's live
    // session cookies, so no re-login is needed. Done before fire so all tabs
    // are ready to race the instant the slot opens.
    const pages: Page[] = [page];
    for (let i = 1; i < PARALLEL; i++) {
      const p = await ctx.newPage();
      p.setDefaultTimeout(30000);
      await p.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await p.waitForSelector(IDS.agreeCheckbox, { timeout: 20000 }).catch(() => {});
      pages.push(p);
    }
    if (PARALLEL > 1) log(`prewarmed ${PARALLEL} parallel tabs.`);

    while (Date.now() < CFG.fireAt) await sleep(20);
    log(`FIRE${PARALLEL > 1 ? ` (${PARALLEL}× parallel)` : ''}. reloading until target date is bookable...`);

    // Race every tab; first to book wins. A losing tab may also commit under
    // BuildingLink's own overlap race — self-double-book is accepted.
    const outcomes = await Promise.allSettled(pages.map((p, i) => fireAndBook(p, PARALLEL > 1 ? `[a${i + 1}]` : '')));
    const won = outcomes.find((o) => o.status === 'fulfilled' && (o.value as ReserveResult).booked) as PromiseFulfilledResult<ReserveResult> | undefined;
    if (won) {
      result.booked = true;
      result.message = won.value.message;
    } else {
      const any = outcomes.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<ReserveResult> | undefined;
      const rej = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined;
      result.booked = false;
      result.message = any ? any.value.message : String(rej?.reason?.message || rej?.reason || 'all attempts failed');
    }
  } catch (err) {
    result.message = String(err && (err as Error).message ? (err as Error).message : err);
    log('ERROR: ' + result.message);
    await shot(page, 'error');
  } finally {
    log('RESERVE_RESULT ' + JSON.stringify(result));
    await sleep(CFG.headless ? 500 : 10000);
    await ctx.close();
    process.exit(result.booked ? 0 : 1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('reserve.ts')) run();
