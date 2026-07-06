// Auth helpers: detect the BuildingLink SSO page and auto-fill the login form
// when credentials are provided via env (BL_USERNAME / BL_PASSWORD).
import type { Page } from 'playwright';
import { AUTH_HOST } from './config.ts';

const authRe = new RegExp(AUTH_HOST.replace(/\./g, '\\.'), 'i');

export const onAuth = (url: string): boolean => {
  try { return authRe.test(new URL(url).hostname); } catch { return false; }
};

// Fill & submit the login form if we're on the auth page and creds exist.
// Returns 'submitted' | 'no-creds' | 'not-login' | 'error:<msg>'.
// NOTE: the auth page renders TWO forms with the same field names — a hidden
// #form--mobile and the visible desktop form — so we must target the VISIBLE
// inputs, and submit with Enter (the desktop submit is an ASP.NET control, not
// a plain type=submit button).
export async function autoLogin(page: Page, log: (msg: string) => void = () => {}): Promise<string> {
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
    return 'error:' + (e && (e as Error).message ? (e as Error).message : String(e));
  }
}
