// Click through every amenity on the Select Amenity page to map name -> id.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const SELECT_URL = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/SelectAmenity.aspx?from=0&selectedDate=';
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');
const LINK_SEL = "a[id*='AmenitiesDataList'][id*='SelectAmenityLink']";

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: { width: 1400, height: 950 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(LINK_SEL, { timeout: 30000 });
  const n = await page.locator(LINK_SEL).count();
  console.log('amenity links found: ' + n);

  const results = [];
  for (let i = 0; i < n; i++) {
    await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(LINK_SEL, { timeout: 20000 });
    const link = page.locator(LINK_SEL).nth(i);
    const listText = (await link.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    await Promise.all([
      page.waitForURL(/NewReservation\.aspx/i, { timeout: 20000 }).catch(() => {}),
      link.click().catch(() => {}),
    ]);
    await page.waitForTimeout(1200);
    const url = page.url();
    const idm = url.match(/amenityId=(\d+)/i);
    const id = idm ? idm[1] : '';
    // heading like "Enter New <NAME> Reservation Request"
    const body = await page.locator('body').innerText().catch(() => '');
    const hm = body.match(/Enter New (.+?) Reservation Request/i);
    const name = hm ? hm[1].trim() : (listText || `Amenity ${id}`);
    console.log(`#${i}: id=${id}  name="${name}"  (list="${listText}")`);
    if (id) results.push({ id, name });
  }

  // de-dupe by id, keep first
  const byId = {};
  results.forEach((r) => { if (!byId[r.id]) byId[r.id] = r.name; });
  const list = Object.entries(byId).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'amenities-all.json'), JSON.stringify(list, null, 2));
  console.log('\nAMENITIES_ALL ' + JSON.stringify(list));
  await page.waitForTimeout(600);
  await ctx.close();
})();
