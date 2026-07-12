// One scanner, three modes (dispatch on argv[2] or SCAN_MODE):
//   availability  -> webapp/amenities-meta.json  (booking windows per amenity)
//   occupancy     -> webapp/occupancy-<id>.json  (what's already booked)
//   reservations  -> webapp/my-reservations.json (my own reservations)
// Each mode shares the browser + auth + a small writeJson helper.
import fs from 'fs';
import { BASE_URL, META_FILE, MY_RES_FILE, occupancyFile } from './config.ts';
import { autoLogin, onAuth } from './auth.ts';
import { withBrowser } from './browser.ts';
import { AMENITIES } from './amenities.ts';

function writeJson(file: string, obj: unknown): void {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ---- availability ----------------------------------------------------------
// Scan every amenity's booking window (Advance Limit + available-date range),
// compute how many days ahead each opens, and save to webapp/amenities-meta.json.
// A target date D becomes bookable at 00:00 local on (D - windowDays).
const AVAIL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const availUrl = (id: string) => `${BASE_URL}/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${id}&from=0&selectedDate=`;

function daysBetween(a: Date, b: Date): number { // whole days from midnight(a) to midnight(b)
  const ma = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const mb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((mb.getTime() - ma.getTime()) / 86400000);
}

async function scanAvailability(): Promise<void> {
  await withBrowser({ headless: false, viewport: { width: 1300, height: 900 }, defaultTimeout: 25000 }, async (page) => {
    const meta: Record<string, unknown> = {};
    const today = new Date();

    for (const a of AMENITIES) {
      try {
        await page.goto(availUrl(a.id), { waitUntil: 'domcontentloaded' });
        if (onAuth(page.url())) { await autoLogin(page, console.log); await page.goto(availUrl(a.id), { waitUntil: 'domcontentloaded' }).catch(() => {}); }
        await page.waitForSelector('#ctl00_ContentPlaceHolder1_StartDatePicker_AD, #ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);

        const raw = await page.evaluate(() => {
          const val = (id: string) => { const e = document.getElementById(id) as HTMLInputElement | null; return e ? e.value : null; };
          const body = (document.body.innerText || '').replace(/\s+/g, ' ');
          return {
            AD: val('ctl00_ContentPlaceHolder1_StartDatePicker_AD'),
            SD: val('ctl00_ContentPlaceHolder1_StartDatePicker_SD'),
            advance: (body.match(/Advance Limit:.*?\.\s*(\([^)]*\))?/i) || [null])[0],
            hours: (body.match(/\b\d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M(?: \(on the following day\))?/i) || [null])[0],
            duration: (body.match(/limited to \d+ (?:hour|minute)s?/i) || [null])[0],
            instructions: (body.match(/Reservation Instructions:.*?(?=Enter New|Available for)/i) || [null])[0],
          };
        });

        // Compute the bookable end date + window length.
        let adStart: number[] | null = null, adEnd: number[] | null = null, windowDays: number | null = null;
        try {
          const arr = JSON.parse(raw.AD as string); // e.g. [[2026,7,2],[2026,7,4],[2026,7,2]]
          if (Array.isArray(arr) && arr.length) {
            adStart = arr[0]; adEnd = arr[1] || arr[0];
          }
        } catch { /* ignore */ }
        if (!adEnd && raw.advance) {
          const m = raw.advance.match(/through ([A-Za-z]+) (\d{1,2}),? (\d{4})/i);
          if (m) { const mo = AVAIL_MONTHS.indexOf(m[1].toLowerCase()); if (mo >= 0) adEnd = [Number(m[3]), mo + 1, Number(m[2])]; }
        }
        if (adEnd) windowDays = daysBetween(today, new Date(adEnd[0], adEnd[1] - 1, adEnd[2]));

        const ruleLabel = raw.advance && (raw.advance.match(/\(([^)]*)\)/) || [null, null])[1];
        const label = (ruleLabel || '').toLowerCase();
        // Classify the advance rule. 'week' = whole current Sun-Sat week (opens
        // Sunday 00:00). 'fixed' = a stable N-day-ahead offset. Party Room /
        // Guest Suites have huge offsets => effectively always open.
        let ruleType = 'unknown', offsetDays: number | null = null;
        if (/current week/.test(label)) ruleType = 'week';
        else if (/current & next day/.test(label)) { ruleType = 'fixed'; offsetDays = 1; }
        else { const dm = label.match(/next (\d+) day/); if (dm) { ruleType = 'fixed'; offsetDays = Number(dm[1]); }
          else if (windowDays !== null) { ruleType = 'fixed'; offsetDays = windowDays; } }

        let opensRule;
        if (ruleType === 'week') opensRule = 'current calendar week — opens Sunday 00:00';
        else if (ruleType === 'fixed' && offsetDays != null) {
          opensRule = offsetDays > 3000 ? 'far in advance (effectively always open)'
            : offsetDays <= 0 ? 'same day only'
            : `${offsetDays} day(s) ahead — opens 00:00 the night it enters the window`;
        } else opensRule = 'unknown';

        meta[a.id] = {
          name: a.name, ruleType, offsetDays, opensRule,
          ruleLabel: ruleLabel || null,                 // e.g. "Current & Next Day"
          advanceText: raw.advance || null,
          hours: raw.hours || null,
          duration: raw.duration || null,
          adEnd,
          scrapedOn: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
        };
        console.log(`${a.name.padEnd(38)} ${ruleType.padEnd(7)} off=${offsetDays}  ${ruleLabel || ''}`);
      } catch (e) {
        meta[a.id] = { name: a.name, windowDays: null, opensRule: 'unknown', error: String((e as Error).message || e) };
        console.log(`${a.name.padEnd(38)} ERROR ${(e as Error).message || e}`);
      }
    }

    writeJson(META_FILE, meta);
    console.log('\nWrote ' + META_FILE);
    await page.waitForTimeout(500);
  });
}

// ---- occupancy -------------------------------------------------------------
// Scrape what's already booked for ONE amenity over the next N days from the
// Availability Grid. Writes webapp/occupancy-<amenityId>.json.
// Env: AMENITY_ID, AMENITY_NAME, DAYS (default 14).
const parseLbl = (t: string) => { const m = (t || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); if (!m) return null; let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + Number(m[2]); };
const fmtMin = (x: number) => { x = ((x % 1440) + 1440) % 1440; const h = Math.floor(x / 60), m = x % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return `${h12}:${String(m).padStart(2, '0')} ${ap}`; };
const mdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function scanOccupancy(): Promise<void> {
  const ID = process.env.AMENITY_ID || '29916';
  const NAME = process.env.AMENITY_NAME || 'Tennis Court';
  const DAYS = Math.max(1, Math.min(31, parseInt(process.env.DAYS || '14', 10)));
  const OUT = occupancyFile(ID);
  // lowercase path avoids the V2->v2 redirect that can interrupt goto in a loop
  const GRID = `${BASE_URL}/v2/tenant/amenities/availabilitygrid.aspx`;

  await withBrowser({ headless: process.env.HEADLESS === '1', viewport: { width: 1600, height: 1000 }, defaultTimeout: 30000 }, async (p) => {
    const days: unknown[] = [];
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

        const day = await p.evaluate((amenityName: string) => {
          const grid = document.getElementById('ctl00_ContentPlaceHolder1_ReservationsGridTable') as HTMLTableElement | null;
          const tt = document.getElementById('ctl00_ContentPlaceHolder1_TimeTable') as HTMLTableElement | null;
          if (!grid || !tt) return { error: 'no grid' } as { error: string };
          const times = [...tt.rows].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim());
          const header = [...grid.rows[0].cells].map((c) => (c.innerText || '').replace(/\s+/g, ' ').replace(/\(shared.*/i, '').trim());
          const want = amenityName.toLowerCase();
          let col = header.findIndex((h) => h.toLowerCase() === want);
          if (col < 0) col = header.findIndex((h) => h && (h.toLowerCase().startsWith(want.slice(0, 16)) || want.startsWith(h.toLowerCase().slice(0, 16))));
          if (col < 0) return { error: 'amenity column not found', header: header.filter(Boolean).slice(0, 25) };
          // Status is the cell TEXT (Reserved/Requested/Restricted/Available or a
          // resident/suite name). Only keep real time rows (skip repeated headers).
          const slots: { time: string; label: string }[] = [];
          for (let r = 1; r < grid.rows.length; r++) {
            const time = times[r - 1] || '';
            if (!/\d{1,2}:\d{2}\s*[AP]M/i.test(time)) continue;
            const cell = grid.rows[r].cells[col];
            if (!cell) continue;
            slots.push({ time: time, label: (cell.innerText || '').replace(/\s+/g, ' ').trim() });
          }
          return { slots };
        }, NAME);

        const label = `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
        if ('error' in day && day.error) { days.push({ date: isoDate(d), label, error: day.error }); continue; }

        // A slot is "busy" if it's not Available/Restricted/blank (Reserved,
        // Requested, or a named booking). Merge consecutive same-label slots.
        const isBusy = (l: string) => l && !/^(available|restricted)$/i.test(l);
        const ranges: { label: string; startMin: number | null; lastMin: number }[] = [];
        let cur: { label: string; startMin: number | null; lastMin: number } | null = null;
        for (const s of (day as { slots: { time: string; label: string }[] }).slots) {
          if (isBusy(s.label)) {
            const min = parseLbl(s.time);
            if (cur && cur.label === s.label) cur.lastMin = min as number;
            else { if (cur) ranges.push(cur); cur = { label: s.label, startMin: min, lastMin: min as number }; }
          } else if (cur) { ranges.push(cur); cur = null; }
        }
        if (cur) ranges.push(cur);
        const busy = ranges.filter((r) => r.startMin != null).map((r) => ({
          status: /request/i.test(r.label) ? 'Requested' : (/^reserved$/i.test(r.label) ? 'Reserved' : r.label),
          start: fmtMin(r.startMin as number), end: fmtMin(r.lastMin + 30),
        }));
        days.push({ date: isoDate(d), label, busy });
      }
      writeJson(OUT, { amenityId: ID, amenityName: NAME, generatedAt: new Date().toISOString(), days });
      console.log('OCCUPANCY_DONE ' + days.length + ' days');
    } catch (e) {
      console.log('ERROR ' + (e && (e as Error).message ? (e as Error).message : e));
      try { writeJson(OUT, { amenityId: ID, amenityName: NAME, generatedAt: new Date().toISOString(), days, error: String((e as Error).message || e) }); } catch { /* ignore */ }
      process.exitCode = 1;
    } finally {
      await p.waitForTimeout(300);
    }
  });
}

// ---- reservations ----------------------------------------------------------
// Scrape "My Reservations" into webapp/my-reservations.json.
const RES_URL = `${BASE_URL}/V2/Tenant/Amenities/MyReservations.aspx?from=0`;

function parseStart(dateStr: string | null, timeStr: string | null): number | null {
  // dateStr like "7/4/26", timeStr like "9:00 AM"
  const dm = (dateStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  const tm = (timeStr || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!dm || !tm) return null;
  const mo = dm[1], d = dm[2]; let y = Number(dm[3]); if (y < 100) y += 2000;
  let h = Number(tm[1]) % 12; if (/PM/i.test(tm[3])) h += 12;
  return new Date(y, Number(mo) - 1, Number(d), h, Number(tm[2]), 0, 0).getTime();
}

// Scrape the My Reservations grid into structured rows (shared by scan + cancel).
// editId comes from each row's "View/Edit" link (EditReservation.aspx?id=NNN) —
// it's the handle we cancel by.
async function readReservations(p: import('playwright').Page) {
  const rows = await p.evaluate(() => {
    const t = document.getElementById('ctl00_ContentPlaceHolder1_ReservationsGrid_ctl00') as HTMLTableElement | null;
    if (!t) return [] as { amenity: string; details: string; status: string; editId: string | null }[];
    return [...t.rows].slice(1).map((r) => {
      const link = r.querySelector('a[href*="EditReservation.aspx"]') as HTMLAnchorElement | null;
      const editId = link ? (link.getAttribute('href') || '').match(/[?&]id=(\d+)/i)?.[1] || null : null;
      return {
        amenity: (r.cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
        details: (r.cells[1]?.innerText || '').replace(/\s+/g, ' ').trim(),
        status: (r.cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
        editId,
      };
    }).filter((r) => r.amenity);
  });
  return rows.map((r) => {
    const m = r.details.match(/Duration:\s*[A-Za-z]*\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+to\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
    const date = m ? m[1] : null, start = m ? m[2] : null, end = m ? m[3] : null;
    return { amenity: r.amenity, status: r.status, date, start, end, editId: r.editId, startsAt: parseStart(date, start) };
  }).sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
}

async function scanReservations(): Promise<void> {
  await withBrowser({ headless: process.env.HEADLESS === '1', viewport: { width: 1400, height: 950 }, defaultTimeout: 30000 }, async (p) => {
    try {
      await p.goto(RES_URL, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);
      if (onAuth(p.url())) { await autoLogin(p, console.log); await p.goto(RES_URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1500); }
      if (onAuth(p.url())) throw new Error('not signed in (auto-login failed / no creds)');

      const reservations = await readReservations(p);
      writeJson(MY_RES_FILE, { updatedAt: new Date().toISOString(), reservations });
      console.log('MY_RESERVATIONS ' + reservations.length);
    } catch (e) {
      console.log('ERROR ' + (e && (e as Error).message ? (e as Error).message : e));
      process.exitCode = 1;
    } finally {
      await p.waitForTimeout(300);
    }
  });
}

// ---- cancel ----------------------------------------------------------------
// Cancel one reservation by its edit id (the id in the row's EditReservation.aspx
// link). BuildingLink's flow: open the edit page, click "Edit" to enter edit mode
// (that reveals the cancel button), then click "Cancel Reservation" and accept the
// confirm. Env: CANCEL_ID (required), plus CANCEL_LABEL for logging. Rewrites
// my-reservations.json on exit so the panel reflects the change.
const EDIT_URL = (id: string) => `${BASE_URL}/V2/Tenant/Amenities/EditReservation.aspx?id=${id}&from=2`;

async function cancelReservation(): Promise<void> {
  const ID = process.env.CANCEL_ID || '';
  const LABEL = process.env.CANCEL_LABEL || ID;
  const result = { cancelled: false, message: '' };
  await withBrowser({ headless: process.env.HEADLESS === '1', viewport: { width: 1400, height: 950 }, defaultTimeout: 30000 }, async (p) => {
    p.on('dialog', (d) => { console.log('confirm dialog: ' + d.message()); d.accept().catch(() => {}); });   // accept "are you sure?"
    try {
      if (!ID) throw new Error('missing reservation id to cancel');
      const goEdit = async () => { await p.goto(EDIT_URL(ID), { waitUntil: 'domcontentloaded' }).catch(() => {}); await p.waitForTimeout(1500); };
      await goEdit();
      if (onAuth(p.url())) { await autoLogin(p, console.log); await goEdit(); }
      if (onAuth(p.url())) throw new Error('not signed in (auto-login failed / no creds)');

      // Enter edit mode — the Cancel Reservation button only renders after this.
      const editSel = '#ctl00_ContentPlaceHolder1_HeaderEditButton, #ctl00_ContentPlaceHolder1_FooterEditButton';
      if (!(await p.locator(editSel).count().catch(() => 0))) throw new Error('no Edit button — reservation not editable (past or already cancelled?)');
      await p.locator(editSel).first().click().catch(() => {});
      await p.waitForTimeout(2500);   // RadAjax swaps the content panel in

      const cancelSel = '#ctl00_ContentPlaceHolder1_FooterCancelReservationButton, #ctl00_ContentPlaceHolder1_HeaderCancelReservationButton';
      if (!(await p.locator(cancelSel).count().catch(() => 0))) throw new Error('Cancel Reservation button did not appear after Edit');
      console.log('clicking Cancel Reservation for ' + LABEL);
      await Promise.all([p.waitForLoadState('domcontentloaded').catch(() => {}), p.locator(cancelSel).first().click().catch(() => {})]);
      await p.waitForTimeout(2500);

      // Verify + refresh: reload My Reservations and confirm this id is gone.
      // The grid can lag a beat after the cancel postback, so poll a few times
      // before concluding it failed.
      let reservations: Awaited<ReturnType<typeof readReservations>> = [];
      let stillThere = true;
      for (let attempt = 0; attempt < 4 && stillThere; attempt++) {
        await p.goto(RES_URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1500);
        if (onAuth(p.url())) { await autoLogin(p, console.log); continue; }
        reservations = await readReservations(p);
        stillThere = reservations.some((r) => r.editId === ID);
      }
      writeJson(MY_RES_FILE, { updatedAt: new Date().toISOString(), reservations });
      result.cancelled = !stillThere;
      result.message = stillThere ? `still present after cancel — check the site (${LABEL})` : `cancelled ${LABEL}`;
    } catch (e) {
      result.message = String((e as Error).message || e);
      console.log('ERROR ' + result.message);
      process.exitCode = 1;
    } finally {
      console.log('CANCEL_RESULT ' + JSON.stringify(result));
      await p.waitForTimeout(300);
    }
  });
}

// ---- dispatch --------------------------------------------------------------
async function main(): Promise<void> {
  const mode = process.argv[2] || process.env.SCAN_MODE || 'availability';
  if (mode === 'availability') return scanAvailability();
  if (mode === 'occupancy') return scanOccupancy();
  if (mode === 'reservations') return scanReservations();
  if (mode === 'cancel') return cancelReservation();
  console.error(`unknown scan mode: ${mode} (expected availability|occupancy|reservations|cancel)`);
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('scan.ts')) main();
