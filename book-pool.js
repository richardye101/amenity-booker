// Real end-to-end test: book the Pool (amenityId 61230) and CAPTURE the actual
// POST request(s) + responses so we can see what a raw replay would require.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AMENITY_ID = process.env.AMENITY_ID || '61230'; // Pool
const RES_URL = `https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${AMENITY_ID}&from=0&selectedDate=`;
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');
fs.mkdirSync(OUT, { recursive: true });

const CFG = {
  targetTitle: process.env.TARGET_TITLE || 'July 03, 2026',
  Y: 2026, MO: 6, D: parseInt(process.env.D || '3', 10),
  startTime: process.env.START_TIME || '9:00 AM',
  endTime: process.env.END_TIME || '10:00 AM',
  startH: parseInt(process.env.START_H || '9', 10),
  endH: parseInt(process.env.END_H || '10', 10),
  dryRun: process.env.DRY_RUN === '1',
};

const postLog = path.join(OUT, 'pool-post.txt');
fs.writeFileSync(postLog, '');
const rec = (s) => fs.appendFileSync(postLog, s + '\n');

const IDS = {
  startTimePicker: 'ctl00_ContentPlaceHolder1_StartTimePicker',
  endTimePicker: 'ctl00_ContentPlaceHolder1_EndTimePicker',
  startTimeInput: '#ctl00_ContentPlaceHolder1_StartTimePicker_dateInput',
  endTimeInput: '#ctl00_ContentPlaceHolder1_EndTimePicker_dateInput',
  agree: '#ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox',
  save: '#ctl00_ContentPlaceHolder1_FooterSaveButton',
};
const dateCellSel = `td[title*="${CFG.targetTitle}"] a`;
const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);

  // ---- capture POSTs to the residents host --------------------------------
  page.on('request', (req) => {
    if (req.method() === 'POST' && /harbourviewresidents\.buildinglink\.com/i.test(req.url())) {
      const data = req.postData() || '';
      rec('==== POST ' + req.url());
      rec('---- headers: ' + JSON.stringify(req.headers()));
      rec('---- body length: ' + data.length);
      rec('---- body (first 6000):\n' + data.slice(0, 6000));
      rec('');
    }
  });
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && /harbourviewresidents\.buildinglink\.com/i.test(res.url())) {
      rec(`>>>> RESPONSE ${res.status()} ${res.url()}`);
    }
  });

  try {
    log('loading pool reservation page...');
    await page.goto(RES_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(IDS.agree, { timeout: 20000 });

    log('selecting date ' + CFG.targetTitle);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(dateCellSel).first().click(),
    ]);
    await page.waitForTimeout(1500);

    const readV = async () => ({
      start: await page.locator(IDS.startTimeInput).inputValue().catch(() => ''),
      end: await page.locator(IDS.endTimeInput).inputValue().catch(() => ''),
    });

    // Pool's time pickers AutoPostBack on change, so type like a human and wait
    // for each postback to settle (setting start may reset/refresh end).
    log('typing start time...');
    await page.locator(IDS.startTimeInput).click();
    await page.locator(IDS.startTimeInput).fill(CFG.startTime);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(IDS.startTimeInput).press('Enter'),
    ]);
    await page.waitForTimeout(1500);

    log('typing end time...');
    await page.locator(IDS.endTimeInput).click();
    await page.locator(IDS.endTimeInput).fill(CFG.endTime);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(IDS.endTimeInput).press('Enter'),
    ]);
    await page.waitForTimeout(1500);
    let v = await readV();
    log(`times after typing: start="${v.start}" end="${v.end}"`);

    log('ticking waiver...');
    await page.locator(IDS.agree).check({ force: true });

    v = await readV();
    const checked = await page.locator(IDS.agree).isChecked();
    log(`VERIFY start="${v.start}" end="${v.end}" agreed=${checked}`);
    await page.screenshot({ path: path.join(OUT, 'pool-before-save.png') });

    if (CFG.dryRun) {
      log('DRY RUN: not saving.');
    } else {
      log('clicking Save (REAL booking)...');
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator(IDS.save).click(),
      ]);
      await page.waitForTimeout(3500);
      await page.screenshot({ path: path.join(OUT, 'pool-after-save.png'), fullPage: true });
      const body = await page.locator('body').innerText().catch(() => '');
      log('after-save url=' + page.url());
      log('after-save text (first 600): ' + body.replace(/\s+/g, ' ').slice(0, 600));
    }
  } catch (e) {
    log('ERROR: ' + (e.message || e));
    await page.screenshot({ path: path.join(OUT, 'pool-error.png') }).catch(() => {});
  } finally {
    await page.waitForTimeout(1500);
    await ctx.close();
  }
})();
