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
const PRIMARY: Slot = {
  label: 'PRIMARY 9-10',
  startTime: process.env.START_TIME || '9:00 AM',
  endTime: process.env.END_TIME || '10:00 AM',
  startH: parseInt(process.env.START_H || '9', 10),
  endH: parseInt(process.env.END_H || '10', 10),
};
const FALLBACK: Slot = {
  label: 'FALLBACK 10-11',
  startTime: process.env.FB_START_TIME || '10:00 AM',
  endTime: process.env.FB_END_TIME || '11:00 AM',
  startH: parseInt(process.env.FB_START_H || '10', 10),
  endH: parseInt(process.env.FB_END_H || '11', 10),
};

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
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator(dateCellSel).first().click(),
  ]);
  await page.waitForTimeout(700);
}

// Fill times + waiver, verify, and Save. Returns {booked, message}.
async function fillAndSave(page: Page, slot: Slot): Promise<ReserveResult> {
  log(`${slot.label}: setting times ${slot.startTime}-${slot.endTime}`);
  await page.evaluate(
    ({ sid, eid, Y, MO, D, sH, eH }) => {
      try {
        const s = (window as any).$find && (window as any).$find(sid);
        const e = (window as any).$find && (window as any).$find(eid);
        if (s && s.set_selectedDate) s.set_selectedDate(new Date(Y, MO, D, sH, 0, 0));
        if (e && e.set_selectedDate) e.set_selectedDate(new Date(Y, MO, D, eH, 0, 0));
      } catch { /* ignore */ }
    },
    { sid: IDS.startTimePicker, eid: IDS.endTimePicker, Y: CFG.Y, MO: CFG.MO, D: CFG.D, sH: slot.startH, eH: slot.endH }
  );
  const readV = async () => ({
    start: await page.locator(IDS.startTimeInput).inputValue().catch(() => ''),
    end: await page.locator(IDS.endTimeInput).inputValue().catch(() => ''),
  });
  let v = await readV();
  if (norm(v.start) !== norm(slot.startTime)) {
    await page.locator(IDS.startTimeInput).click();
    await page.locator(IDS.startTimeInput).fill(slot.startTime).catch(() => {});
    await page.locator(IDS.startTimeInput).press('Enter').catch(() => {});
    await page.waitForTimeout(500);
  }
  v = await readV();
  if (norm(v.end) !== norm(slot.endTime)) {
    await page.locator(IDS.endTimeInput).click();
    await page.locator(IDS.endTimeInput).fill(slot.endTime).catch(() => {});
    await page.locator(IDS.endTimeInput).press('Enter').catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.locator(IDS.agreeCheckbox).check({ force: true });
  v = await readV();
  const checked = await page.locator(IDS.agreeCheckbox).isChecked().catch(() => false);
  const startOK = norm(v.start) === norm(slot.startTime);
  const endOK = norm(v.end) === norm(slot.endTime);
  log(`${slot.label}: VERIFY start="${v.start}"(${startOK}) end="${v.end}"(${endOK}) agreed=${checked}`);
  await shot(page, `${slot.startH}-filled`);
  if (!startOK || !endOK || !checked) return { booked: false, message: `verify failed for ${slot.label}` };

  if (CFG.dryRun) return { booked: true, message: `DRY RUN ${slot.label} (not saved)` };

  log(`${slot.label}: clicking Save...`);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator(IDS.footerSave).click(),
  ]);
  await page.waitForTimeout(3000);
  await shot(page, `${slot.startH}-after-save`);
  const url = page.url();
  // Real UI save: success redirects OFF NewReservation.aspx (to CalendarView).
  const booked = !/NewReservation\.aspx/i.test(url);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const errSnip = (bodyText.match(/Please correct the following error\(s\):([\s\S]{0,160})/i) || ['', ''])[1].replace(/\s+/g, ' ').trim();
  log(`${slot.label}: after-save url=${url} booked=${booked} error="${errSnip}"`);
  return { booked, message: booked ? `BOOKED ${slot.label}` : `NOT booked ${slot.label}: ${errSnip || 'stayed on form'}` };
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
    while (Date.now() < CFG.fireAt) await sleep(20);
    log('FIRE. reloading until target date is bookable...');

    // FIRE: rapid reload-poll until the target date is bookable
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
        log(`reload #${n}: "${CFG.targetTitle}" bookable (+${Date.now() - CFG.fireAt}ms).`);
        break;
      }
      await sleep(250);
    }
    if (!ready) throw new Error(`"${CFG.targetTitle}" never became bookable within 45s`);

    // Select the date, then try PRIMARY; if it fails, reload + try FALLBACK.
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(dateCellSel).first().click(),
    ]);
    await page.waitForTimeout(700);

    let r = await fillAndSave(page, PRIMARY);
    log('PRIMARY result: ' + r.message);
    if (!r.booked) {
      log('primary did not book; trying fallback slot...');
      await ensureDateSelected(page);
      r = await fillAndSave(page, FALLBACK);
      log('FALLBACK result: ' + r.message);
    }
    result.booked = r.booked;
    result.message = r.message;
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
