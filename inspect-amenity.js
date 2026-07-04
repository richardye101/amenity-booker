// Inspect an amenity's reservation page: title, advance window, available
// dates/times, default start/end, and any time-slot list. AMENITY_ID env req.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ID = process.env.AMENITY_ID || '37908';
const RES_URL = `https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=${ID}&from=0&selectedDate=`;
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT = path.join(__dirname, 'capture');

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('#ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const txt = (sel) => {
      const e = document.querySelector(sel);
      return e ? (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ') : null;
    };
    const val = (id) => {
      const e = document.getElementById(id);
      return e ? e.value : null;
    };
    // Available calendar days (have a title + anchor).
    const days = Array.from(document.querySelectorAll('td.availableDay[title], td.availableDate[title]'))
      .map((td) => td.getAttribute('title'));
    // Time-slot list options if present.
    const slotList = document.getElementById('ctl00_ContentPlaceHolder1_AvailabileTimeSlotsList') ||
      document.getElementById('ctl00_ContentPlaceHolder1_AvailableTimeSlotsList');
    const slots = slotList ? (slotList.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 400) : null;
    return {
      heading: txt('#ctl00_ContentPlaceHolder1_TitleLabel') || document.title,
      pageText: (document.body.innerText || '').replace(/\s+/g, ' ').match(/Advance Limit[^.]*\./i)?.[0] || null,
      instructions: (document.body.innerText || '').replace(/\s+/g, ' ').match(/Reservation Instructions:[^]*?(Available|Allocation)/i)?.[0]?.slice(0, 300) || null,
      availableTimesTomorrow: (document.body.innerText || '').replace(/\s+/g, ' ').match(/Available Times Tomorrow:[^A-Z]{0,80}/i)?.[0] || null,
      startDefault: val('ctl00_ContentPlaceHolder1_StartTimePicker_dateInput'),
      endDefault: val('ctl00_ContentPlaceHolder1_EndTimePicker_dateInput'),
      SD: val('ctl00_ContentPlaceHolder1_StartDatePicker_SD'),
      AD: val('ctl00_ContentPlaceHolder1_StartDatePicker_AD'),
      availableDays: days,
      slots,
      hasStartTimePicker: !!document.getElementById('ctl00_ContentPlaceHolder1_StartTimePicker_dateInput'),
    };
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `amenity-${ID}.json`), JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(OUT, `amenity-${ID}.png`), fullPage: true }).catch(() => {});
  console.log('INFO ' + JSON.stringify(info, null, 2));
  await page.waitForTimeout(800);
  await ctx.close();
})();
