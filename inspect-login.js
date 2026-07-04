// Inspect the BuildingLink login form using a FRESH (logged-out) context, so we
// can see whether auto-login is feasible (plain fields vs MFA/CAPTCHA).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const RES_URL = 'https://harbourviewresidents.buildinglink.com/V2/Tenant/Amenities/NewReservation.aspx?amenityId=29916&from=0&selectedDate=';
const OUT = path.join(__dirname, 'capture');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 850 } }); // no cookies
  const page = await ctx.newPage();
  await page.goto(RES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3500); // let it redirect to the auth login page
  console.log('LOGIN URL: ' + page.url());

  const info = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll('input, button, select')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 40),
      autocomplete: el.getAttribute('autocomplete') || '',
    })).filter((f) => f.type !== 'hidden');
    const bodyText = (document.body.innerText || '').toLowerCase();
    return {
      fields,
      captcha: /captcha|recaptcha|hcaptcha|are you human|i'm not a robot/i.test(document.documentElement.outerHTML),
      mfaHint: /(two-factor|2fa|verification code|one-time|authenticator|mfa)/i.test(bodyText),
      title: document.title,
    };
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'login-form.json'), JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(OUT, 'login-form.png'), fullPage: true }).catch(() => {});
  console.log('LOGIN_FORM ' + JSON.stringify(info, null, 2));
  await page.waitForTimeout(800);
  await browser.close();
})();
