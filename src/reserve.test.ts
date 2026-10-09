import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';

Object.assign(process.env, {
  TARGET_TITLE: 'October 10, 2026', START_TIME: '10:00 AM', END_TIME: '11:00 AM',
  FB_START_TIME: '11:00 AM', FB_END_TIME: '12:00 PM', DRY_RUN: '0',
  RUN_TAG: `test-reserve-${process.pid}`,
});
const { fireAndBook } = await import('./reserve.ts');

for (const outcome of ['primary booked', 'fallback booked', 'both rejected']) {
  test(outcome, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    let loads = 0;
    const saves: Record<string, string>[] = [];
    const form = (rejected = false) => `
      <table><tr><td title="October 10, 2026"><a href="#" onclick="
        document.querySelector('form').hidden = false; return false;">10</a></td></tr></table>
      <form method="post" ${rejected ? '' : 'hidden'}>
        ${rejected ? '<p>Correct the following error(s): This Amenity does not allow two reservations for the same time period.</p>' : ''}
        <input type="hidden" name="date" value="2026-10-10">
        <input name="start" id="ctl00_ContentPlaceHolder1_StartTimePicker_dateInput" value="${rejected ? '10:00 AM' : '7:00 AM'}">
        <input name="end" id="ctl00_ContentPlaceHolder1_EndTimePicker_dateInput" value="${rejected ? '11:00 AM' : '8:00 AM'}">
        <input name="agreed" type="checkbox" id="ctl00_ContentPlaceHolder1_liabilityWaiverAgreeCheckbox">
        <button id="ctl00_ContentPlaceHolder1_FooterSaveButton">Save</button>
      </form>`;
    // Every request is intercepted: these tests cannot create real reservations.
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname.endsWith('/Calendar.aspx')) {
        await route.fulfill({ contentType: 'text/html', body: 'Booked' });
      } else if (request.method() === 'POST') {
        saves.push(Object.fromEntries(new URLSearchParams(request.postData() || '')));
        const booked = outcome === 'primary booked' || (outcome === 'fallback booked' && saves.length === 2);
        if (booked) {
          await route.fulfill({ status: 302, headers: { location: '/Calendar.aspx' } });
        } else {
          await route.fulfill({ contentType: 'text/html', body: form(true) });
        }
      } else {
        loads++;
        // A second GET discards the already-selected date; fail without a 20s waiver wait.
        if (loads > 1) await route.abort();
        else await route.fulfill({ contentType: 'text/html', body: form() });
      }
    });

    const result = await fireAndBook(page, outcome);
    assert.equal(loads, 1, 'fallback must reuse the rejected form');
    assert.equal(result.booked, outcome !== 'both rejected');
    assert.deepEqual(saves, [
      { date: '2026-10-10', start: '10:00 AM', end: '11:00 AM', agreed: 'on' },
      ...(outcome === 'primary booked' ? [] : [
        { date: '2026-10-10', start: '11:00 AM', end: '12:00 PM', agreed: 'on' },
      ]),
    ]);
    assert.match(result.message, outcome === 'primary booked' ? /BOOKED primary/ : /fallback/);
    if (outcome === 'both rejected') assert.match(result.message, /NOT booked.*does not allow/);
  });
}
