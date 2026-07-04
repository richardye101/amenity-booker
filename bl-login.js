// Shared auth helpers: load .env (zero-dep) and auto-fill the BuildingLink
// login form when credentials are provided via env (BL_USERNAME / BL_PASSWORD).
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const onAuth = (url) => {
  try { return /auth\.buildinglink\.com/i.test(new URL(url).hostname); } catch (_) { return false; }
};

// Fill & submit the login form if we're on the auth page and creds exist.
// Returns 'submitted' | 'no-creds' | 'not-login' | 'error:<msg>'.
// NOTE: the auth page renders TWO forms with the same field names — a hidden
// #form--mobile and the visible desktop form — so we must target the VISIBLE
// inputs, and submit with Enter (the desktop submit is an ASP.NET control, not
// a plain type=submit button).
async function autoLogin(page, log = () => {}) {
  if (!onAuth(page.url())) return 'not-login';
  const user = process.env.BL_USERNAME;
  const pass = process.env.BL_PASSWORD;
  if (!user || !pass) return 'no-creds';
  try {
    const u = page.locator('input[name="Username"]:visible').first();
    const pw = page.locator('input[name="Password"]:visible').first();
    await u.waitFor({ state: 'visible', timeout: 20000 });
    await u.fill(user);
    await pw.fill(pass);
    log('auto-login: submitting credentials...');
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      pw.press('Enter'),
    ]);
    await page.waitForTimeout(2500);
    // Fallback: if still on the auth page, click a visible login button (avoid
    // the separate "Single Sign-on" link).
    if (onAuth(page.url())) {
      const btn = page.locator('button:visible, input[type=submit]:visible, a:visible')
        .filter({ hasText: /log ?in|login|sign in|submit/i }).first();
      if (await btn.count()) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          btn.click().catch(() => {}),
        ]);
        await page.waitForTimeout(2500);
      }
    }
    return 'submitted';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : String(e));
  }
}

module.exports = { loadEnv, autoLogin, onAuth };
