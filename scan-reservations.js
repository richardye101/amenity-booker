// Scrape "My Reservations" into webapp/my-reservations.json.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv, autoLogin, onAuth } = require('./bl-login');
loadEnv();

const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'webapp', 'my-reservations.json');
const URL = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/MyReservations.aspx?from=0';

function parseStart(dateStr, timeStr) {
  // dateStr like "7/4/26", timeStr like "9:00 AM"
  const dm = (dateStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  const tm = (timeStr || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!dm || !tm) return null;
  let [_, mo, d, y] = dm; y = Number(y); if (y < 100) y += 2000;
  let h = Number(tm[1]) % 12; if (/PM/i.test(tm[3])) h += 12;
  return new Date(y, Number(mo) - 1, Number(d), h, Number(tm[2]), 0, 0).getTime();
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: process.env.HEADLESS === '1', viewport: { width: 1400, height: 950 },
  });
  const p = ctx.pages()[0] || (await ctx.newPage());
  p.setDefaultTimeout(30000);
  try {
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    if (onAuth(p.url())) { await autoLogin(p, console.log); await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1500); }
    if (onAuth(p.url())) throw new Error('not signed in (auto-login failed / no creds)');

    const rows = await p.evaluate(() => {
      const t = document.getElementById('ctl00_ContentPlaceHolder1_ReservationsGrid_ctl00');
      if (!t) return [];
      return [...t.rows].slice(1).map((r) => ({
        amenity: (r.cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
        details: (r.cells[1]?.innerText || '').replace(/\s+/g, ' ').trim(),
        status: (r.cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
      })).filter((r) => r.amenity);
    });

    const reservations = rows.map((r) => {
      const m = r.details.match(/Duration:\s*[A-Za-z]*\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+to\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
      const date = m ? m[1] : null, start = m ? m[2] : null, end = m ? m[3] : null;
      return { amenity: r.amenity, status: r.status, date, start, end, startsAt: parseStart(date, start) };
    }).sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));

    fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), reservations }, null, 2));
    console.log('MY_RESERVATIONS ' + reservations.length);
  } catch (e) {
    console.log('ERROR ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  } finally {
    await p.waitForTimeout(300);
    await ctx.close();
  }
})();
