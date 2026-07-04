// EXPERIMENT: book an amenity via a pure GET->scrape-tokens->POST round-trip
// (no UI clicks), and time it. Uses in-page fetch so the authenticated session
// cookies + same-origin apply automatically.
//
// Env: AMENITY_ID (default 37908 BBQ2), START_INPUT ("4:00 PM"), END_INPUT
//      ("5:00 PM"), START_HH24 (16), END_HH24 (17), SD (default keeps the
//      page's already-selected date), DRY_RUN=1 (scrape+build but don't POST).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ID = process.env.AMENITY_ID || '37908';
const RES_URL = `https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${ID}&from=0&selectedDate=`;
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');

const CFG = {
  startInput: process.env.START_INPUT || '4:00 PM',
  endInput: process.env.END_INPUT || '5:00 PM',
  startHH: process.env.START_HH24 || '16',
  endHH: process.env.END_HH24 || '17',
  sd: process.env.SD || '', // '' => keep page default selected date
  dryRun: process.env.DRY_RUN === '1',
};
// Telerik picker value uses a fixed base date (today) + chosen hour.
const startVal = `2026-07-02-${CFG.startHH}-00-00`;
const endVal = `2026-07-02-${CFG.endHH}-00-00`;
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);

  // Prewarm/auth: land on the page once so cookies are valid for fetch.
  log('prewarming session...');
  await page.goto(RES_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox', { timeout: 20000 });
  log('session live. running GET->POST round-trip...');

  const result = await page.evaluate(async ({ resUrl, startVal, endVal, startInput, endInput, sd, dryRun }) => {
    const timings = {};
    const t0 = performance.now();
    // --- GET fresh page (fresh __PAGESTATEID / __EVENTVALIDATION) ---
    const getRes = await fetch(resUrl, { credentials: 'include' });
    const html = await getRes.text();
    timings.getMs = performance.now() - t0;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector('form');
    if (!form) return { error: 'no form in GET response', htmlLen: html.length };

    // Serialize every successful control (like a browser form submit).
    const body = new URLSearchParams();
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      const name = el.getAttribute('name');
      if (!name) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) body.append(name, el.getAttribute('value') || 'on');
      } else if (el.tagName === 'SELECT') {
        const opt = el.querySelector('option[selected]') || el.options[el.selectedIndex] || el.options[0];
        body.append(name, opt ? opt.value : '');
      } else {
        body.append(name, el.getAttribute('value') || '');
      }
    });

    // Grab the tokens we scraped (for reporting).
    const tokenPeek = {
      pageStateId: (body.get('__PAGESTATEID') || '').slice(0, 60),
      eventValidationLen: (body.get('__EVENTVALIDATION') || '').length,
      viewStateLen: (body.get('__VIEWSTATE') || '').length,
    };

    // --- Override the fields for our reservation ---
    body.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$FooterSaveButton');
    body.set('__EVENTARGUMENT', '');
    if (sd) body.set('ctl00_ContentPlaceHolder1_StartDatePicker_SD', sd);
    body.set('ctl00$ContentPlaceHolder1$StartTimePicker', startVal);
    body.set('ctl00$ContentPlaceHolder1$StartTimePicker$dateInput', startInput);
    body.set('ctl00$ContentPlaceHolder1$EndTimePicker', endVal);
    body.set('ctl00$ContentPlaceHolder1$EndTimePicker$dateInput', endInput);
    // waiver checkbox: ensure present + checked
    body.set('ctl00$ContentPlaceHolder1$liabilityWaiverAgreeCheckbox', 'on');

    const fieldCount = Array.from(body.keys()).length;
    if (dryRun) {
      return { dryRun: true, timings, tokenPeek, fieldCount, sdUsed: body.get('ctl00_ContentPlaceHolder1_StartDatePicker_SD') };
    }

    // --- POST it back (synchronous postback; follows 302 to CalendarView on success) ---
    const tp = performance.now();
    const postRes = await fetch(resUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    const text = await postRes.text();
    timings.postMs = performance.now() - tp;
    timings.totalMs = performance.now() - t0;

    return {
      timings,
      tokenPeek,
      fieldCount,
      status: postRes.status,
      finalUrl: postRes.url,
      leftForm: !/NewReservation\.aspx/i.test(postRes.url),
      hasError: /Please correct the following|Concurrency Limit|is not available|already/i.test(text),
      errorSnippet: (text.match(/Please correct the following error\(s\):[^<]*(?:<[^>]*>[^<]*){0,4}/i) || [''])[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 200),
      respLen: text.length,
    };
  }, { resUrl: RES_URL, startVal, endVal, startInput: CFG.startInput, endInput: CFG.endInput, sd: CFG.sd, dryRun: CFG.dryRun });

  log('RESULT ' + JSON.stringify(result, null, 2));

  // Visually verify via the calendar.
  await page.goto('https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/CalendarView.aspx?selectedDate=', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `rawpost-${ID}-calendar.png`), fullPage: true }).catch(() => {});
  const mine = await page.locator('body').innerText().catch(() => '');
  const m = mine.match(/View My Reservations \((\d+)\)/i);
  if (m) log('View My Reservations count now: ' + m[1]);

  await page.waitForTimeout(800);
  await ctx.close();
})();
