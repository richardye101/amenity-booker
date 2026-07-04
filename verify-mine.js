const { chromium } = require('playwright');
const path = require('path');
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');
(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: { width: 1400, height: 950 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/CalendarView.aspx?selectedDate=', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const header = await page.locator('body').innerText().catch(() => '');
  const m = header.match(/View My Reservations \((\d+)\)/i);
  console.log('COUNT ' + (m ? m[1] : 'n/a'));
  // Tick "Show only my reservations" to declutter.
  const cb = page.getByText(/Show only my reservations/i).locator('xpath=preceding-sibling::input | //input[@type="checkbox"][following-sibling::*[contains(.,"only my")]]').first();
  try { await page.getByLabel(/Show only my reservations/i).check({ force: true }); } catch (_) {
    try { await page.locator('input[type=checkbox]').first().check({ force: true }); } catch (_) {}
  }
  await page.waitForTimeout(2500);
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const bbq = (txt.match(/\d{1,2}:\d{2} [AP]M - \d{1,2}:\d{2} [AP]M BBQ2/gi) || []);
  console.log('MY BBQ2 SLOTS: ' + JSON.stringify(bbq));
  await page.screenshot({ path: path.join(OUT, 'my-reservations.png'), fullPage: true }).catch(() => {});
  await page.waitForTimeout(500);
  await ctx.close();
})();
