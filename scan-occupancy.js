// Scrape what's already booked for ONE amenity over the next N days from the
// Availability Grid. Writes webapp/occupancy-<amenityId>.json.
// Env: AMENITY_ID, AMENITY_NAME, DAYS (default 14).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv, autoLogin, onAuth } = require('./bl-login');
loadEnv();

const USER_DATA_DIR = path.join(__dirname, 'user-data');
const ID = process.env.AMENITY_ID || '29916';
const NAME = process.env.AMENITY_NAME || 'Tennis Court';
const DAYS = Math.max(1, Math.min(31, parseInt(process.env.DAYS || '14', 10)));
const OUT = path.join(__dirname, 'webapp', `occupancy-${ID}.json`);
// lowercase path avoids the V2->v2 redirect that can interrupt goto in a loop
const GRID = 'https://harbourviewresidents.buildinglink.com/v2/tenant/amenities/availabilitygrid.aspx';

const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: process.env.HEADLESS === '1', viewport: { width: 1600, height: 1000 } });
  const p = ctx.pages()[0] || (await ctx.newPage());
  p.setDefaultTimeout(30000);
  const days = [];
  try {
    const today = new Date();
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const url = `${GRID}?selectedDate=${encodeURIComponent(mdy(d))}`;
      const goDay = async () => { await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await p.waitForLoadState('domcontentloaded').catch(() => {}); };
      await goDay();
      await p.waitForTimeout(i === 0 ? 1800 : 1200);
      if (onAuth(p.url())) { await autoLogin(p, console.log); await goDay(); await p.waitForTimeout(1500); }
      if (onAuth(p.url())) throw new Error('not signed in');

      const day = await p.evaluate((amenityName) => {
        const grid = document.getElementById('ctl00_ContentPlaceHolder1_ReservationsGridTable');
        const tt = document.getElementById('ctl00_ContentPlaceHolder1_TimeTable');
        if (!grid || !tt) return { error: 'no grid' };
        const times = [...tt.rows].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim());
        const header = [...grid.rows[0].cells].map((c) => (c.innerText || '').replace(/\s+/g, ' ').replace(/\(shared.*/i, '').trim());
        let col = header.findIndex((h) => h && amenityName.startsWith(h.slice(0, 10)) && h.startsWith(amenityName.slice(0, 10)));
        if (col < 0) col = header.findIndex((h) => h.toLowerCase().includes(amenityName.toLowerCase().slice(0, 12)));
        if (col < 0) return { error: 'amenity column not found', header };
        const slots = [];
        for (let r = 1; r < grid.rows.length; r++) {
          const cell = grid.rows[r].cells[col];
          if (!cell) continue;
          const m = (cell.className || '').match(/ReservationGridCell-(\w+)/);
          slots.push({ time: times[r - 1] || '', status: m ? m[1] : 'Unknown' });
        }
        return { slots };
      }, NAME);

      if (day.error) { days.push({ date: iso(d), label: `${dow[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`, error: day.error }); continue; }

      // Merge consecutive Reserved/Requested slots into busy ranges.
      const busy = [];
      let cur = null;
      const endLabel = (t) => t; // time label of a slot is its start; range end = next slot's start
      for (let k = 0; k < day.slots.length; k++) {
        const s = day.slots[k];
        const isBusy = /Reserved|Requested/i.test(s.status);
        if (isBusy) {
          if (cur && cur.status === s.status) cur.endIdx = k;
          else { if (cur) busy.push(cur); cur = { status: s.status, startIdx: k, endIdx: k }; }
        } else if (cur) { busy.push(cur); cur = null; }
      }
      if (cur) busy.push(cur);
      const ranges = busy.map((b) => ({
        status: b.status,
        start: day.slots[b.startIdx].time,
        end: (day.slots[b.endIdx + 1] && day.slots[b.endIdx + 1].time) || 'end',
      }));
      days.push({ date: iso(d), label: `${dow[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`, busy: ranges });
    }
    fs.writeFileSync(OUT, JSON.stringify({ amenityId: ID, amenityName: NAME, generatedAt: new Date().toISOString(), days }, null, 2));
    console.log('OCCUPANCY_DONE ' + days.length + ' days');
  } catch (e) {
    console.log('ERROR ' + (e && e.message ? e.message : e));
    try { fs.writeFileSync(OUT, JSON.stringify({ amenityId: ID, amenityName: NAME, generatedAt: new Date().toISOString(), days, error: String(e.message || e) }, null, 2)); } catch (_) {}
    process.exitCode = 1;
  } finally {
    await p.waitForTimeout(300);
    await ctx.close();
  }
})();
