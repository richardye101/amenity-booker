// Discover ALL amenity IDs from the Select Amenity page.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const SELECT_URL = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/SelectAmenity.aspx?from=0&selectedDate=';
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: { width: 1400, height: 950 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // ensure logged in / on select page
  for (let i = 0; i < 60 && !/SelectAmenity\.aspx/i.test(new URL(page.url()).pathname); i++) {
    await page.waitForTimeout(1500);
    if (!/auth\.buildinglink\.com/i.test(page.url())) await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(2500);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'select.html'), await page.content());
  await page.screenshot({ path: path.join(OUT, 'select.png'), fullPage: true }).catch(() => {});

  // Try to extract (name, id) by scanning every element for an amenityId in any
  // attribute (href/onclick/data-*), pairing with the nearest text.
  const pairs = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('*').forEach((el) => {
      let hay = '';
      for (const a of el.attributes || []) hay += ' ' + a.name + '=' + a.value;
      const m = hay.match(/amenityId=(\d+)/i);
      if (m) {
        const id = m[1];
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const key = id + '|' + text;
        if (!seen.has(key)) { seen.add(key); out.push({ id, text, tag: el.tagName.toLowerCase() }); }
      }
    });
    return out;
  });
  fs.writeFileSync(path.join(OUT, 'select-pairs.json'), JSON.stringify(pairs, null, 2));
  console.log('PAIRS ' + JSON.stringify(pairs, null, 2));
  console.log('COUNT ' + pairs.length);
  await page.waitForTimeout(800);
  await ctx.close();
})();
