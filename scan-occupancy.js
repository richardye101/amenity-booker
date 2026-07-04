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

const parseLbl = (t) => { const m = (t || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); if (!m) return null; let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + Number(m[2]); };
const fmtMin = (x) => { x = ((x % 1440) + 1440) % 1440; const h = Math.floor(x / 60), m = x % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return `${h12}:${String(m).padStart(2, '0')} ${ap}`; };
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
        const want = amenityName.toLowerCase();
        let col = header.findIndex((h) => h.toLowerCase() === want);
        if (col < 0) col = header.findIndex((h) => h && (h.toLowerCase().startsWith(want.slice(0, 16)) || want.startsWith(h.toLowerCase().slice(0, 16))));
        if (col < 0) return { error: 'amenity column not found', header: header.filter(Boolean).slice(0, 25) };
        // Status is the cell TEXT (Reserved/Requested/Restricted/Available or a
        // resident/suite name). Only keep real time rows (skip repeated headers).
        const slots = [];
        for (let r = 1; r < grid.rows.length; r++) {
          const time = times[r - 1] || '';
          if (!/\d{1,2}:\d{2}\s*[AP]M/i.test(time)) continue;
          const cell = grid.rows[r].cells[col];
          if (!cell) continue;
          slots.push({ time: time, label: (cell.innerText || '').replace(/\s+/g, ' ').trim() });
        }
        return { slots };
      }, NAME);

      const label = `${dow[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
      if (day.error) { days.push({ date: iso(d), label, error: day.error }); continue; }

      // A slot is "busy" if it's not Available/Restricted/blank (Reserved,
      // Requested, or a named booking). Merge consecutive same-label slots.
      const isBusy = (l) => l && !/^(available|restricted)$/i.test(l);
      const ranges = [];
      let cur = null;
      for (const s of day.slots) {
        if (isBusy(s.label)) {
          const min = parseLbl(s.time);
          if (cur && cur.label === s.label) cur.lastMin = min;
          else { if (cur) ranges.push(cur); cur = { label: s.label, startMin: min, lastMin: min }; }
        } else if (cur) { ranges.push(cur); cur = null; }
      }
      if (cur) ranges.push(cur);
      const busy = ranges.filter((r) => r.startMin != null).map((r) => ({
        status: /request/i.test(r.label) ? 'Requested' : (/^reserved$/i.test(r.label) ? 'Reserved' : r.label),
        start: fmtMin(r.startMin), end: fmtMin(r.lastMin + 30),
      }));
      days.push({ date: iso(d), label, busy });
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
