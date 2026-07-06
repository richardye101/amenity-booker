// Click through every amenity on the Select Amenity page to map name -> id.
import fs from 'fs';
import path from 'path';
import { BASE_URL, CAPTURE_DIR } from './config.ts';
import { withBrowser } from './browser.ts';

const SELECT_URL = `${BASE_URL}/V2/Tenant/Amenities/SelectAmenity.aspx?from=0&selectedDate=`;
const LINK_SEL = "a[id*='AmenitiesDataList'][id*='SelectAmenityLink']";

async function main(): Promise<void> {
  await withBrowser({ headless: false, viewport: { width: 1400, height: 950 } }, async (page) => {
    await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(LINK_SEL, { timeout: 30000 });
    const n = await page.locator(LINK_SEL).count();
    console.log('amenity links found: ' + n);

    const results: { id: string; name: string }[] = [];
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
    const byId: Record<string, string> = {};
    results.forEach((r) => { if (!byId[r.id]) byId[r.id] = r.name; });
    const list = Object.entries(byId).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAPTURE_DIR, 'amenities-all.json'), JSON.stringify(list, null, 2));
    console.log('\nAMENITIES_ALL ' + JSON.stringify(list));
    await page.waitForTimeout(600);
  });
}

if (process.argv[1] && process.argv[1].endsWith('map-amenities.ts')) main();
