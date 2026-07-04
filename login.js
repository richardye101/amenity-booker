// Open a headed browser so the user can log into BuildingLink. Persists the
// session to ./user-data, then closes. Exits 0 once a tenant page is reached.
const { chromium } = require('playwright');
const path = require('path');
const { loadEnv, autoLogin, onAuth } = require('./bl-login');
loadEnv();
const USER_DATA_DIR = path.join(__dirname, 'user-data');
const CHECK_URL = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/CalendarView.aspx?selectedDate=';

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: { width: 1400, height: 950 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  console.log('LOGIN: opening BuildingLink; log in if prompted...');
  await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // With .env creds we auto-login (no human), so don't wait long. Without them,
  // give the user time to sign in manually in the window.
  const hasCreds = !!(process.env.BL_USERNAME && process.env.BL_PASSWORD);
  const deadline = Date.now() + (hasCreds ? 70 * 1000 : 6 * 60 * 1000);
  const onTenant = () => {
    try { return /harbourviewresidents\.buildinglink\.com/i.test(new URL(page.url()).hostname) && !/auth\./i.test(new URL(page.url()).hostname); }
    catch (_) { return false; }
  };
  let autoTries = 0;
  while (Date.now() < deadline && !onTenant()) {
    // If creds are in .env, auto-fill the login form (unattended). Otherwise the
    // user signs in manually in the window.
    if (onAuth(page.url()) && autoTries < 2) {
      autoTries++;
      const r = await autoLogin(page, console.log);
      console.log('auto-login: ' + r);
      if (r === 'no-creds') console.log('LOGIN: no BL_USERNAME/BL_PASSWORD in .env — sign in manually in the window.');
    }
    await page.waitForTimeout(1500);
    if (!onTenant() && !onAuth(page.url())) {
      await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  const ok = onTenant();
  console.log('LOGIN_RESULT ' + JSON.stringify({ ok, url: page.url() }));
  await page.waitForTimeout(1200);
  await ctx.close();
  process.exit(ok ? 0 : 1);
})();
