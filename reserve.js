// BuildingLink Tennis Court reservation bot.
// Reuses the logged-in session in ./user-data (created by capture.js).
// Reloads the reservation page until the target date becomes bookable, then
// selects date + start/end time, ticks the liability waiver, and clicks Save.
//
// Config via env (defaults target Saturday July 4, 2026, 9:00-10:00 AM):
//   TARGET_TITLE  substring of the calendar cell title, e.g. "July 04, 2026"
//   Y, MO, D      JS date parts for the reservation (MO is 0-based; July = 6)
//   START_TIME    display text for start, e.g. "9:00 AM"
//   END_TIME      display text for end,   e.g. "10:00 AM"
//   START_H, END_H  hour-of-day integers for the Telerik client API (9, 10)
//   DRY_RUN=1     fill everything but DO NOT click Save
//   HEADLESS=1    run without a visible browser window
//   MAX_WAIT_MS   how long to keep reloading waiting for the date (default 180s)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RES_URL =
  'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=29916&from=0&selectedDate=';
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const LOG_DIR = path.join(__dirname, 'run-logs');

const CFG = {
  targetTitle: process.env.TARGET_TITLE || 'July 04, 2026',
  Y: parseInt(process.env.Y || '2026', 10),
  MO: parseInt(process.env.MO || '6', 10), // 0-based; 6 = July
  D: parseInt(process.env.D || '4', 10),
  startTime: process.env.START_TIME || '9:00 AM',
  endTime: process.env.END_TIME || '10:00 AM',
  startH: parseInt(process.env.START_H || '9', 10),
  endH: parseInt(process.env.END_H || '10', 10),
  dryRun: process.env.DRY_RUN === '1',
  headless: process.env.HEADLESS === '1',
  maxWaitMs: parseInt(process.env.MAX_WAIT_MS || '180000', 10),
};

const IDS = {
  startTimePicker: 'ctl00_ContentPlaceHolder1_StartTimePicker',
  endTimePicker: 'ctl00_ContentPlaceHolder1_EndTimePicker',
  startTimeInput: '#ctl00_ContentPlaceHolder1_StartTimePicker_dateInput',
  endTimeInput: '#ctl00_ContentPlaceHolder1_EndTimePicker_dateInput',
  agreeCheckbox: '#ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox',
  footerSave: '#ctl00_ContentPlaceHolder1_FooterSaveButton',
  headerSave: '#ctl00_ContentPlaceHolder1_HeaderSaveButton',
};

fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const runTag = stamp();
const logFile = path.join(LOG_DIR, `run-${runTag}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
}
async function shot(page, name) {
  const p = path.join(LOG_DIR, `${runTag}-${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log(`screenshot: ${p}`);
}

// The available calendar cell for the target date: has a title AND a clickable <a>.
const dateCellSel = `td[title*="${CFG.targetTitle}"] a`;

(async () => {
  log(`START reserve.js dryRun=${CFG.dryRun} headless=${CFG.headless} target="${CFG.targetTitle}" ${CFG.startTime}-${CFG.endTime}`);
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: CFG.headless,
    viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);

  let result = { ok: false, saved: false, message: '' };
  try {
    // ---- 1. Reload until the target date is bookable ------------------------
    const deadline = Date.now() + CFG.maxWaitMs;
    let ready = false;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err: ' + e.message));

      // Session expired -> we cannot auto-login. Bail loudly.
      if (/auth\.buildinglink\.com/i.test(page.url())) {
        throw new Error('Redirected to login (session expired). Re-run capture.js to log in again.');
      }

      const cell = page.locator(dateCellSel).first();
      const found = await cell.count().catch(() => 0);
      if (found > 0) {
        ready = true;
        log(`attempt ${attempt}: target date "${CFG.targetTitle}" is now bookable.`);
        break;
      }
      log(`attempt ${attempt}: "${CFG.targetTitle}" not bookable yet; reloading in 2s...`);
      await page.waitForTimeout(2000);
    }
    if (!ready) throw new Error(`Timed out: "${CFG.targetTitle}" never became bookable within ${CFG.maxWaitMs}ms.`);

    await shot(page, '1-loaded');

    // ---- 2. Select the date (calendar postback) -----------------------------
    log('clicking target date cell...');
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(dateCellSel).first().click(),
    ]);
    await page.waitForTimeout(2500); // let the availability panel / pickers refresh
    await shot(page, '2-date-selected');

    // ---- 3. Set start & end time via the Telerik client API -----------------
    log('setting times via Telerik client API...');
    const setTimes = await page.evaluate(
      ({ sid, eid, Y, MO, D, startH, endH }) => {
        const out = {};
        try {
          const s = window.$find ? window.$find(sid) : null;
          const e = window.$find ? window.$find(eid) : null;
          if (s && s.set_selectedDate) {
            s.set_selectedDate(new Date(Y, MO, D, startH, 0, 0));
            out.start = 'api';
          }
          if (e && e.set_selectedDate) {
            e.set_selectedDate(new Date(Y, MO, D, endH, 0, 0));
            out.end = 'api';
          }
        } catch (err) {
          out.error = String(err);
        }
        return out;
      },
      { sid: IDS.startTimePicker, eid: IDS.endTimePicker, Y: CFG.Y, MO: CFG.MO, D: CFG.D, startH: CFG.startH, endH: CFG.endH }
    );
    log('client API result: ' + JSON.stringify(setTimes));

    // Fallback: type into the visible time inputs if the API path didn't take.
    const readInputs = async () => ({
      start: await page.locator(IDS.startTimeInput).inputValue().catch(() => ''),
      end: await page.locator(IDS.endTimeInput).inputValue().catch(() => ''),
    });
    let vals = await readInputs();
    log('time inputs after API: ' + JSON.stringify(vals));
    if (vals.start.replace(/\s+/g, '').toLowerCase() !== CFG.startTime.replace(/\s+/g, '').toLowerCase()) {
      log('typing start time fallback...');
      await page.locator(IDS.startTimeInput).click();
      await page.locator(IDS.startTimeInput).press('Control+a').catch(() => {});
      await page.locator(IDS.startTimeInput).fill(CFG.startTime).catch(() => {});
      await page.locator(IDS.startTimeInput).press('Enter').catch(() => {});
      await page.waitForTimeout(800);
    }
    vals = await readInputs();
    if (vals.end.replace(/\s+/g, '').toLowerCase() !== CFG.endTime.replace(/\s+/g, '').toLowerCase()) {
      log('typing end time fallback...');
      await page.locator(IDS.endTimeInput).click();
      await page.locator(IDS.endTimeInput).press('Control+a').catch(() => {});
      await page.locator(IDS.endTimeInput).fill(CFG.endTime).catch(() => {});
      await page.locator(IDS.endTimeInput).press('Enter').catch(() => {});
      await page.waitForTimeout(800);
    }
    await shot(page, '3-times-set');

    // ---- 4. Tick the liability waiver ---------------------------------------
    log('checking the agreement box...');
    await page.locator(IDS.agreeCheckbox).check({ force: true });
    await page.waitForTimeout(300);
    await shot(page, '4-agreed');

    // ---- 5. Verify everything before saving ---------------------------------
    vals = await readInputs();
    const checked = await page.locator(IDS.agreeCheckbox).isChecked().catch(() => false);
    const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
    const startOK = norm(vals.start) === norm(CFG.startTime);
    const endOK = norm(vals.end) === norm(CFG.endTime);
    log(`VERIFY start="${vals.start}"(${startOK}) end="${vals.end}"(${endOK}) agreed=${checked}`);

    if (!startOK || !endOK || !checked) {
      result.message = `Verification failed (startOK=${startOK} endOK=${endOK} agreed=${checked}); NOT saving.`;
      log('!! ' + result.message);
      await shot(page, '5-verify-failed');
      throw new Error(result.message);
    }

    // ---- 6. Save ------------------------------------------------------------
    if (CFG.dryRun) {
      result.ok = true;
      result.message = 'DRY RUN: all fields verified, Save intentionally skipped.';
      log(result.message);
      await shot(page, '5-dryrun-ready');
    } else {
      log('clicking Save...');
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator(IDS.footerSave).click(),
      ]);
      await page.waitForTimeout(3500);
      await shot(page, '6-after-save');

      const bodyText = await page.locator('body').innerText().catch(() => '');
      const url = page.url();
      const errorHit = /error|unavailable|conflict|already|not available|invalid|exceed|must be/i.test(bodyText) &&
        !/no error/i.test(bodyText);
      // Heuristic: leaving the NewReservation page (back to calendar/list) usually means success.
      const leftForm = !/NewReservation\.aspx/i.test(url);
      result.saved = true;
      result.ok = leftForm || !errorHit;
      result.message = `after-save url=${url} leftForm=${leftForm} possibleError=${errorHit}`;
      log(result.message);
      // Log a trimmed snapshot of visible text for post-mortem.
      log('page text (first 800 chars): ' + bodyText.replace(/\s+/g, ' ').slice(0, 800));
    }
  } catch (err) {
    result.message = result.message || String(err && err.message ? err.message : err);
    log('ERROR: ' + result.message);
    await shot(page, 'error');
  } finally {
    log('RESERVE_RESULT ' + JSON.stringify(result));
    await page.waitForTimeout(1000);
    await ctx.close();
    process.exit(result.ok ? 0 : 1);
  }
})();
