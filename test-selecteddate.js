const { chromium } = require('playwright');
const path = require('path');
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const BASE = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=29916&from=0&selectedDate=';
const formats = ['07/02/2026', '2026-07-02', '7/2/2026', '07-02-2026'];
(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: { width: 1400, height: 950 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  // default (no selectedDate)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ctl00_ContentPlaceHolder1_StartDatePicker_SD', { timeout: 20000 }).catch(() => {});
  const def = await page.locator('#ctl00_ContentPlaceHolder1_StartDatePicker_SD').inputValue().catch(() => '?');
  console.log('DEFAULT SD = ' + def);
  for (const f of formats) {
    await page.goto(BASE + encodeURIComponent(f), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_StartDatePicker_SD', { timeout: 15000 }).catch(() => {});
    const sd = await page.locator('#ctl00_ContentPlaceHolder1_StartDatePicker_SD').inputValue().catch(() => '?');
    const start = await page.locator('#ctl00_ContentPlaceHolder1_StartTimePicker_dateInput').inputValue().catch(() => '?');
    console.log(`selectedDate="${f}" -> SD=${sd}  start=${start}`);
  }
  await ctx.close();
})();
