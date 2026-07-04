// Scan every amenity's booking window (Advance Limit + available-date range),
// compute how many days ahead each opens, and save to webapp/amenities-meta.json.
// A target date D becomes bookable at 00:00 local on (D - windowDays).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loadEnv, autoLogin, onAuth } = require('./bl-login');
loadEnv();
const AMENITIES = require('./amenities');
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'webapp', 'amenities-meta.json');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const url = (id) => `https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${id}&from=0&selectedDate=`;

function daysBetween(a, b) { // whole days from midnight(a) to midnight(b)
  const ma = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const mb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((mb - ma) / 86400000);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: { width: 1300, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(25000);
  const meta = {};
  const today = new Date();

  for (const a of AMENITIES) {
    try {
      await page.goto(url(a.id), { waitUntil: 'domcontentloaded' });
      if (onAuth(page.url())) { await autoLogin(page, console.log); await page.goto(url(a.id), { waitUntil: 'domcontentloaded' }).catch(() => {}); }
      await page.waitForSelector('#ctl00_ContentPlaceHolder1_StartDatePicker_AD, #ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);

      const raw = await page.evaluate(() => {
        const val = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
        const body = (document.body.innerText || '').replace(/\s+/g, ' ');
        return {
          AD: val('ctl00_ContentPlaceHolder1_StartDatePicker_AD'),
          SD: val('ctl00_ContentPlaceHolder1_StartDatePicker_SD'),
          advance: (body.match(/Advance Limit:.*?\.\s*(\([^)]*\))?/i) || [null])[0],
          hours: (body.match(/\b\d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M(?: \(on the following day\))?/i) || [null])[0],
          duration: (body.match(/limited to \d+ (?:hour|minute)s?/i) || [null])[0],
          instructions: (body.match(/Reservation Instructions:.*?(?=Enter New|Available for)/i) || [null])[0],
        };
      });

      // Compute the bookable end date + window length.
      let adStart = null, adEnd = null, windowDays = null;
      try {
        const arr = JSON.parse(raw.AD); // e.g. [[2026,7,2],[2026,7,4],[2026,7,2]]
        if (Array.isArray(arr) && arr.length) {
          adStart = arr[0]; adEnd = arr[1] || arr[0];
        }
      } catch (_) {}
      if (!adEnd && raw.advance) {
        const m = raw.advance.match(/through ([A-Za-z]+) (\d{1,2}),? (\d{4})/i);
        if (m) { const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo >= 0) adEnd = [Number(m[3]), mo + 1, Number(m[2])]; }
      }
      if (adEnd) windowDays = daysBetween(today, new Date(adEnd[0], adEnd[1] - 1, adEnd[2]));

      const ruleLabel = raw.advance && (raw.advance.match(/\(([^)]*)\)/) || [null, null])[1];
      const label = (ruleLabel || '').toLowerCase();
      // Classify the advance rule. 'week' = whole current Sun-Sat week (opens
      // Sunday 00:00). 'fixed' = a stable N-day-ahead offset. Party Room /
      // Guest Suites have huge offsets => effectively always open.
      let ruleType = 'unknown', offsetDays = null;
      if (/current week/.test(label)) ruleType = 'week';
      else if (/current & next day/.test(label)) { ruleType = 'fixed'; offsetDays = 1; }
      else { const dm = label.match(/next (\d+) day/); if (dm) { ruleType = 'fixed'; offsetDays = Number(dm[1]); }
        else if (windowDays !== null) { ruleType = 'fixed'; offsetDays = windowDays; } }

      let opensRule;
      if (ruleType === 'week') opensRule = 'current calendar week — opens Sunday 00:00';
      else if (ruleType === 'fixed' && offsetDays != null) {
        opensRule = offsetDays > 3000 ? 'far in advance (effectively always open)'
          : offsetDays <= 0 ? 'same day only'
          : `${offsetDays} day(s) ahead — opens 00:00 the night it enters the window`;
      } else opensRule = 'unknown';

      meta[a.id] = {
        name: a.name, ruleType, offsetDays, opensRule,
        ruleLabel: ruleLabel || null,                 // e.g. "Current & Next Day"
        advanceText: raw.advance || null,
        hours: raw.hours || null,
        duration: raw.duration || null,
        adEnd,
        scrapedOn: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      };
      console.log(`${a.name.padEnd(38)} ${ruleType.padEnd(7)} off=${offsetDays}  ${ruleLabel || ''}`);
    } catch (e) {
      meta[a.id] = { name: a.name, windowDays: null, opensRule: 'unknown', error: String(e.message || e) };
      console.log(`${a.name.padEnd(38)} ERROR ${e.message || e}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(meta, null, 2));
  console.log('\nWrote ' + OUT);
  await page.waitForTimeout(500);
  await ctx.close();
})();
