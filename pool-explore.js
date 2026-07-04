// Open the Pool reservation page by clicking through Select Amenity, then dump
// its URL (amenityId), controls, and a screenshot.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SELECT_URL =
  'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/SelectAmenity.aspx?from=0&selectedDate=';
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);

  // Click the "Pool" amenity (exact text match, prefer a clickable element).
  console.log('clicking Pool...');
  const pool = page.getByText(/^\s*Pool\s*$/).first();
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    pool.click({ timeout: 15000 }),
  ]).catch((e) => console.log('click err: ' + e.message));
  await page.waitForTimeout(3500);

  const url = page.url();
  console.log('POOL_URL ' + url);

  const controls = await page.evaluate(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      value: (el.getAttribute('value') || '').slice(0, 40),
      text: (el.innerText || el.textContent || '').trim().slice(0, 50),
    });
    return Array.from(document.querySelectorAll('input, select, button, a, textarea'))
      .map(pick)
      .filter((c) => c.id || c.text || c.type === 'checkbox');
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'pool-controls.json'), JSON.stringify(controls, null, 2));
  fs.writeFileSync(path.join(OUT, 'pool.html'), await page.content());
  await page.screenshot({ path: path.join(OUT, 'pool.png'), fullPage: true }).catch(() => {});
  // Print the interesting bits.
  const interesting = controls.filter((c) =>
    /ContentPlaceHolder1|SaveButton|Time|Date|Agree|Waiver|checkbox/i.test(c.id + c.type)
  );
  console.log('POOL_CONTROLS ' + JSON.stringify(interesting, null, 2));
  await page.waitForTimeout(1000);
  await ctx.close();
})();
