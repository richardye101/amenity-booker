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
async function autoLogin(page, log = () => {}) {
  if (!onAuth(page.url())) return 'not-login';
  const user = process.env.BL_USERNAME;
  const pass = process.env.BL_PASSWORD;
  if (!user || !pass) return 'no-creds';
  try {
    // Single-page form: #UserName + #Password + #LoginButton ("Next").
    if (await page.locator('#UserName').count()) {
      await page.fill('#UserName', user);
    }
    if (await page.locator('#Password').count()) {
      await page.fill('#Password', pass);
    }
    log('auto-login: submitting credentials...');
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.click('#LoginButton, button[type=submit]').catch(() => {}),
    ]);
    await page.waitForTimeout(2000);
    // Two-step variant: password appears on a second screen.
    if (onAuth(page.url()) && (await page.locator('#Password').count()) && !(await page.locator('#UserName').count())) {
      await page.fill('#Password', pass);
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        page.click('#LoginButton, button[type=submit]').catch(() => {}),
      ]);
      await page.waitForTimeout(2000);
    }
    return 'submitted';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : String(e));
  }
}

module.exports = { loadEnv, autoLogin, onAuth };
