// Phase 1: Launch a headed browser with a persistent profile, wait for the user
// to log into BuildingLink, then dump the live reservation page's HTML + a
// screenshot so we can build accurate selectors for the real form.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RES_URL =
  'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=29916&from=0&selectedDate=';
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const OUT_DIR = path.join(__dirname, 'capture');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1400, height: 950 },
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  console.log('>> Opening reservation page. If prompted, LOG IN in the browser window.');
  await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Poll until we're actually on the reservation page (login complete).
  const deadline = Date.now() + 8 * 60 * 1000; // up to 8 minutes to log in
  let onPage = false;
  let lastNav = Date.now(); // when we last auto-navigated (after the initial goto)
  while (Date.now() < deadline) {
    const url = page.url();
    // Only match when the *path* (not the login page's returnUrl query) is the
    // reservation page on the residents host — never the auth.buildinglink.com login.
    let isRes = false;
    try {
      const loc = new URL(url);
      isRes =
        /(^|\.)buildinglink\.com$/i.test(loc.hostname) &&
        !/^auth\./i.test(loc.hostname) &&
        /NewReservation\.aspx$/i.test(loc.pathname);
    } catch (_) {}
    // The reservation form has a Save button; use that as a readiness signal.
    const hasForm = await page
      .locator('input[type="submit"], button, input[value*="Save" i]')
      .count()
      .catch(() => 0);
    if (isRes && hasForm > 0) {
      // Give async panels a moment to render.
      await page.waitForTimeout(2500);
      onPage = true;
      break;
    }
    // Do NOT re-navigate while the user is mid-login (that reloads the page out
    // from under them). Only nudge back to the reservation page if they're
    // clearly logged in (on the residents host, not auth) but sitting elsewhere,
    // and only occasionally.
    let onAuth = true;
    try {
      onAuth = /^auth\./i.test(new URL(url).hostname);
    } catch (_) {}
    if (!isRes && !onAuth && Date.now() - lastNav > 25000) {
      lastNav = Date.now();
      await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    console.log(`   waiting... current url: ${url}`);
    await page.waitForTimeout(4000);
  }

  if (!onPage) {
    console.log('!! Timed out waiting for the reservation page. Dumping whatever is loaded.');
  }

  const html = await page.content();
  fs.writeFileSync(path.join(OUT_DIR, 'reservation.html'), html);
  await page.screenshot({ path: path.join(OUT_DIR, 'reservation.png'), fullPage: true }).catch(() => {});

  // Also dump a concise inventory of interactive controls to speed up selector work.
  const controls = await page.evaluate(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      value: el.getAttribute('value') || '',
      text: (el.innerText || el.textContent || '').trim().slice(0, 60),
      placeholder: el.getAttribute('placeholder') || '',
      title: el.getAttribute('title') || '',
    });
    const els = Array.from(
      document.querySelectorAll('input, select, button, a[onclick], textarea')
    );
    return els.map(pick);
  });
  fs.writeFileSync(path.join(OUT_DIR, 'controls.json'), JSON.stringify(controls, null, 2));

  console.log('CAPTURE_DONE url=' + page.url());
  console.log('Wrote capture/reservation.html, reservation.png, controls.json');
  // Keep the browser open briefly so the session is flushed to disk.
  await page.waitForTimeout(1500);
  await ctx.close();
})();
