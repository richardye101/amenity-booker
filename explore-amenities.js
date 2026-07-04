// List all reservable amenities (name + amenityId) from the Select Amenity page.
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
  // wait until logged in / on the select page
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline && !/SelectAmenity\.aspx/i.test(new URL(page.url()).pathname)) {
    await page.waitForTimeout(2000);
    if (!/auth\.buildinglink\.com/i.test(page.url()) && !/SelectAmenity\.aspx/i.test(new URL(page.url()).pathname)) {
      await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  await page.waitForTimeout(2500);

  const amenities = await page.evaluate(() => {
    const rows = [];
    // Any link that points at a NewReservation page carries the amenityId.
    document.querySelectorAll('a[href*="NewReservation.aspx"], a[href*="amenityId="]').forEach((a) => {
      const m = a.getAttribute('href').match(/amenityId=(\d+)/i);
      rows.push({
        id: m ? m[1] : '',
        text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        href: a.getAttribute('href'),
      });
    });
    // Also grab any visible amenity names for context.
    const names = Array.from(document.querySelectorAll('h1,h2,h3,td,span,div'))
      .map((e) => (e.innerText || '').trim())
      .filter((t) => /pool|tennis|gym|party|bbq|guest|court|room|sauna|theatre|theater|lounge|terrace/i.test(t) && t.length < 60);
    return { rows, names: Array.from(new Set(names)).slice(0, 40) };
  });

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'amenities.json'), JSON.stringify(amenities, null, 2));
  await page.screenshot({ path: path.join(OUT, 'amenities.png'), fullPage: true }).catch(() => {});
  console.log('AMENITIES ' + JSON.stringify(amenities, null, 2));
  console.log('DONE url=' + page.url());
  await page.waitForTimeout(1000);
  await ctx.close();
})();
