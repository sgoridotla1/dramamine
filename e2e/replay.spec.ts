import { expect, test } from './fixtures';
import { addMugs, newestPage, replay, replayOk, startRecording, stopRecording, takeCheckpoint } from './helpers';

test.describe('session-replay: steps', () => {
  test('replays with trusted input: clicks, typing, select and Enter', async ({ context, sw, fixture }) => {
    // Trusted-only control.
    const page = await context.newPage();
    await page.goto(`${fixture.url}/trusted.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Buy now' }).click();
    await expect(page.getByTestId('trusted-result')).toHaveText('bought');
    const buy = await stopRecording(sw);
    await page.close();

    const r1 = await replayOk(sw, { id: buy.id });
    expect(r1.report.steps.map((s) => s.status)).toEqual(['ok']);
    await expect(newestPage(context, 'trusted.html').getByTestId('trusted-result')).toHaveText('bought');

    // Form: typing, a redacted password supplied by the caller, a native select and Enter.
    const form = await context.newPage();
    await form.goto(`${fixture.url}/form.html`);
    await startRecording(sw, form);
    await form.getByLabel('Username').pressSequentially('alice');
    await form.getByLabel('Password').click();
    await form.getByLabel('Password').pressSequentially('hunter2');
    await form.getByLabel('Country').focus();
    await form.keyboard.type('Israel');
    await form.getByLabel('Username').click();
    await form.getByLabel('Username').press('Enter');
    await expect(form.getByRole('status')).toHaveText('Welcome alice from Israel');
    const login = await stopRecording(sw);
    await form.close();

    const passwordStep = login.steps.find((s) => s.kind === 'input' && s.redacted)!;
    const r2 = await replayOk(sw, { id: login.id, redactedValues: { [String(passwordStep.index)]: 'hunter2' } });
    expect(r2.report.verdict).toBe('unchecked');
    expect(r2.report.steps.every((s) => s.status === 'ok')).toBe(true);
    const replayed = newestPage(context, 'form.html');
    await expect(replayed.getByRole('status')).toHaveText('Welcome alice from Israel');
    await expect(replayed.getByLabel('Password')).toHaveValue('hunter2');
  });

  test('waits for a delayed element and reports a covered one', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/delayed.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Load' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('delayed-result')).toHaveText('Continued');
    const delayed = await stopRecording(sw);
    await page.close();

    const ok = await replayOk(sw, { id: delayed.id });
    expect(ok.report.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(ok.report.steps[1]!.durationMs).toBeGreaterThan(1500);

    const modal = await context.newPage();
    await modal.goto(`${fixture.url}/modal.html?modalMs=1500`);
    await startRecording(sw, modal);
    await modal.getByRole('button', { name: 'Open notice' }).click();
    await expect(modal.locator('.modal')).toHaveCount(0, { timeout: 3000 });
    await modal.getByRole('button', { name: 'Confirm' }).click();
    const covered = await stopRecording(sw);
    await modal.close();

    // The notice stays up for 1.5 s; with a 500 ms step timeout the click cannot happen.
    const r = await replayOk(sw, { id: covered.id, stepTimeoutMs: 500 });
    expect(r.report.verdict).toBe('error');
    const failed = r.report.steps.find((s) => s.status === 'failed')!;
    expect(failed.error).toContain('another element would receive the input');
  });

  test('a failed step stops the replay, keeps earlier checkpoints and explains redactions', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/delayed.html`);
    await startRecording(sw, page);
    await takeCheckpoint(sw, page, page.getByRole('heading', { name: 'Delayed button' }));
    await page.getByRole('button', { name: 'Load' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('delayed-result')).toHaveText('Continued');
    await takeCheckpoint(sw, page, page.getByTestId('delayed-result'), 'Continued');
    const rec = await stopRecording(sw);
    await page.close();

    // Continue appears after 2 s, so a 500 ms timeout fails step 2.
    const r = await replayOk(sw, { id: rec.id, stepTimeoutMs: 500, checks: [{ checkpoint: 2, op: 'text-equals', value: 'Continued' }] });
    expect(r.report.verdict).toBe('error');
    expect(r.report.failedStep).toBe(2);
    const failed = r.report.steps.find((s) => s.index === 2)!;
    expect(failed.error).toContain("getByRole('button', { name: 'Continue' }) matched no elements");
    expect(failed.tried!.length).toBeGreaterThan(0);
    expect(r.report.checkpoints[0]).toMatchObject({ checkpoint: 1, reached: true });
    expect(r.report.checkpoints[1]).toMatchObject({ checkpoint: 2, reached: false });
    expect(r.report.checkpoints[1]!.checks[0]!.status).toBe('not-evaluated');

    // Redacted password without a supplied value.
    const form = await context.newPage();
    await form.goto(`${fixture.url}/form.html`);
    await startRecording(sw, form);
    await form.getByLabel('Password').click();
    await form.getByLabel('Password').pressSequentially('hunter2');
    await form.getByLabel('Username').click();
    const login = await stopRecording(sw);
    await form.close();
    const r2 = await replayOk(sw, { id: login.id });
    expect(r2.report.verdict).toBe('error');
    expect(r2.report.steps.find((s) => s.status === 'failed')!.error).toContain('redactedValues');
  });

  test('replays a multi-page flow', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/products.html`);
    await expect(page.getByTestId('product-card-1')).toBeVisible();
    await startRecording(sw, page);
    await addMugs(page, fixture.url, 1);
    await page.getByRole('link', { name: 'Cart' }).click();
    await page.getByRole('link', { name: 'Checkout' }).click();
    await expect(page.getByTestId('checkout-status')).toHaveText('Ready to pay');
    const rec = await stopRecording(sw);
    await page.close();

    const r = await replayOk(sw, { id: rec.id });
    expect(r.report.steps.map((s) => [s.kind, s.status])).toEqual([['click', 'ok'], ['click', 'ok'], ['click', 'ok']]);
    expect(r.report.warnings.filter((w) => w.includes('no navigation happened'))).toEqual([]);
    await expect(newestPage(context, 'checkout.html').getByTestId('checkout-status')).toHaveText('Ready to pay');
  });

  test('warns about side effects, flags locator drift and rejects concurrent replays', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await addMugs(page, fixture.url, 1);
    await startRecording(sw, page);
    await addMugs(page, fixture.url, 1);
    await page.getByRole('link', { name: 'Cart' }).click();
    await page.getByTestId('checkout-button').click();
    await expect(page.getByTestId('checkout-status')).toBeVisible();
    const rec = await stopRecording(sw);
    await page.close();

    fixture.setVariant({ renamed: true });
    const first = replay(sw, { id: rec.id });
    await expect.poll(async () => (await sw.evaluate(() => (globalThis as any).str.controller.getState())).replaying).toBe(true);
    const second = await replay(sw, { id: rec.id });
    expect(second).toMatchObject({ ok: false, code: 'busy' });

    const r = await first;
    if (!r.ok) throw new Error(r.message);
    expect(r.report.sideEffects).toEqual([{ method: 'POST', url: `${fixture.url}/api/cart` }]);
    expect(r.report.warnings.some((w) => w.includes('non-GET request') && w.includes('POST /api/cart'))).toBe(true);
    const checkout = r.report.steps[2]!;
    expect(checkout.status).toBe('ok');
    expect(checkout.match).toMatchObject({ fallback: true });
    expect(checkout.match!.candidate).toBeGreaterThan(0);
    expect(r.report.warnings.some((w) => w.includes('fallback locator'))).toBe(true);
  });
});
