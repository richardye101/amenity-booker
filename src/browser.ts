// Persistent-context browser helper. Absorbs the identical launch dance repeated
// across login and the scanners: loadEnv + launchPersistentContext(USER_DATA_DIR)
// + grab the first page + optional default timeout + always close.
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { loadEnv, USER_DATA_DIR } from './config.ts';

export interface WithBrowserOpts {
  headless: boolean;
  viewport: { width: number; height: number };
  defaultTimeout?: number;
}

export async function withBrowser<T>(
  opts: WithBrowserOpts,
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  loadEnv();
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: opts.headless,
    viewport: opts.viewport,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (opts.defaultTimeout != null) page.setDefaultTimeout(opts.defaultTimeout);
  try {
    return await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}
