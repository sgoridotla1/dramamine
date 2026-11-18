import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { addMugs, replayOk, startRecording, stopRecording, takeCheckpoint } from './helpers';

/** Records the cart bug: two mugs, open the cart, checkpoint on the $0 total. */
async function recordCartBug(sw: Worker, page: Page, url: string) {
  await page.goto(`${url}/products.html`);
  await expect(page.getByTestId('product-card-1')).toBeVisible();
  await startRecording(sw, page);
  await addMugs(page, url, 2);
  await page.getByRole('link', { name: 'Cart' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('$0');
  await takeCheckpoint(sw, page, page.getByTestId('cart-total'), 'Total should be $42 (2 x $21)');
  const rec = await stopRecording(sw);
  await page.close();
  return rec;
}

test.describe('session-replay: checks and verdict', () => {
  test('re-captures the checkpoint side by side and retries until the value arrives', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/delayed.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Load' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('delayed-result')).toHaveText('Continued');
    await takeCheckpoint(sw, page, page.getByTestId('delayed-result'), 'Shows Continued');
    const rec = await stopRecording(sw);
    await page.close();

    // The text appears 1 s after the Continue click, i.e. after the checkpoint position is reached.
    const r = await replayOk(sw, { id: rec.id, checks: [{ checkpoint: 1, op: 'text-equals', value: 'Continued' }] });
    expect(r.report.verdict).toBe('green');
    const cp = r.report.checkpoints[0]!;
    expect(cp.recorded.text).toBe('Continued');
    expect(cp.replayed?.text).toBe('Continued');
    expect(cp.screenshots && r.images[cp.screenshots.region] && r.images[cp.screenshots.viewport]).toBeTruthy();
    expect(r.images[cp.recordedScreenshots.region] && r.images[cp.recordedScreenshots.viewport]).toBeTruthy();
  });

  test('red on the bug, green after the fix, unchecked without checks', async ({ context, sw, fixture }) => {
    const rec = await recordCartBug(sw, await context.newPage(), fixture.url);
    const checks = [{ checkpoint: 1, op: 'text-contains' as const, value: '$42' }];

    fixture.state.cart = [];
    const baseline = await replayOk(sw, { id: rec.id, checks });
    expect(baseline.report.verdict).toBe('red');
    expect(baseline.report.checkpoints[0]!.checks[0]).toMatchObject({ status: 'fail', actual: '$0' });
    expect(baseline.report.checkpoints[0]!.replayed?.text).toBe('$0');

    fixture.setVariant({ fixed: true });
    fixture.state.cart = [];
    const verify = await replayOk(sw, { id: rec.id, checks });
    expect(verify.report.verdict).toBe('green');
    expect(verify.report.checkpoints[0]!.checks[0]).toMatchObject({ status: 'pass', actual: '$42' });

    fixture.state.cart = [];
    const unchecked = await replayOk(sw, { id: rec.id });
    expect(unchecked.report.verdict).toBe('unchecked');
    expect(unchecked.report.checkpoints[0]!.replayed?.text).toBe('$42');
  });

  test('global checks and judged checks', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    await page.click('#throw');
    await page.click('#fail');
    await expect(page.getByTestId('misc-out')).toHaveText('status 500');
    await takeCheckpoint(sw, page, page.getByTestId('misc-out'));
    const rec = await stopRecording(sw);
    await page.close();

    const r = await replayOk(sw, {
      id: rec.id,
      checks: [{ checkpoint: 1, op: 'judge' }],
      globalChecks: [{ op: 'no-uncaught-exceptions' }, { op: 'no-http-errors', urlPattern: '/api/' }],
    });
    expect(r.report.verdict).toBe('red');
    const [exceptions, http] = r.report.globalChecks;
    expect(exceptions).toMatchObject({ status: 'fail' });
    expect(exceptions!.detail).toContain("Cannot read properties of undefined (reading 'title')");
    expect(http).toMatchObject({ status: 'fail' });
    expect(http!.detail).toContain('/api/fail -> 500');
    expect(r.report.checkpoints[0]!.checks[0]).toMatchObject({ status: 'judged', actual: 'status 500' });

    // A URL filter that matches nothing passes; judged checks alone leave the verdict unchecked.
    const r2 = await replayOk(sw, { id: rec.id, checks: [{ checkpoint: 1, op: 'judge' }], globalChecks: [{ op: 'no-http-errors', urlPattern: '/api/cart' }] });
    expect(r2.report.globalChecks[0]!.status).toBe('pass');
    expect(r2.report.verdict).toBe('green');
    const r3 = await replayOk(sw, { id: rec.id, checks: [{ checkpoint: 1, op: 'judge' }] });
    expect(r3.report.verdict).toBe('unchecked');
  });

  test('framework-rendered text, late data and missing elements give trustworthy verdicts', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/rendered.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Show total' }).click();
    const cell = page.getByTestId('rendered-total');
    await expect(cell).toHaveText('$0');
    await takeCheckpoint(sw, page, cell, 'Total should be $42');
    const rec = await stopRecording(sw);
    await page.close();
    // "$" and "0" are separate text nodes; the recording reads them the way the user does.
    expect(rec.checkpoints[0]!.actual.text).toBe('$0');

    // The total arrives 1.2 s after the click. "not contains $0" must not pass on "Loading…".
    const checks = [
      { checkpoint: 1, op: 'text-contains' as const, value: '$42' },
      { checkpoint: 1, op: 'text-not-contains' as const, value: '$0' },
    ];
    const baseline = await replayOk(sw, { id: rec.id, checks });
    expect(baseline.report.verdict).toBe('red');
    expect(baseline.report.checkpoints[0]!.checks.map((c) => [c.status, c.actual])).toEqual([
      ['fail', '$0'],
      ['fail', '$0'],
    ]);

    await fixture.setVariant({ fixed: true });
    const verify = await replayOk(sw, { id: rec.id, checks });
    expect(verify.report.verdict).toBe('green');
    expect(verify.report.checkpoints[0]!.replayed?.text).toBe('$42');

    // A check whose element is not on the page is inconclusive, not "the bug reproduces".
    const missing = await replayOk(sw, { id: rec.id, checkTimeoutMs: 800, checks: [{ checkpoint: 1, op: 'text-contains', value: '$42', target: { kind: 'css', selector: '#no-such-element' } }] });
    expect(missing.report.verdict).toBe('error');
    expect(missing.report.checkpoints[0]!.checks[0]!.status).toBe('not-found');
  });
});
