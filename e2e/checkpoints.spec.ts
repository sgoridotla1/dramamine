import type { Page, Worker } from '@playwright/test';
import { renderLocator } from '@str/shared';
import { expect, test } from './fixtures';
import { startRecording, stopRecording, uiState, userSteps } from './helpers';

/** Same path as the keyboard shortcut handler (chrome.commands cannot be pressed by automation). */
async function trigger(sw: Worker, page: Page) {
  const res = await sw.evaluate(() => (globalThis as any).str.controller.triggerCheckpoint());
  expect(res).toEqual({ ok: true });
  await expect(page.locator('str-checkpoint')).toBeAttached();
}

async function drag(page: Page, box: { x: number; y: number; width: number; height: number }, inset = 2) {
  await page.mouse.move(box.x + inset, box.y + inset);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width - inset, box.y + box.height - inset, { steps: 3 });
  await page.mouse.up();
}

async function closed(sw: Worker) {
  await expect.poll(() => sw.evaluate(() => (globalThis as any).str.controller.checkpointOpen())).toBe(false);
  await expect.poll(async () => (await uiState(sw)).recording?.paused).toBe(false);
}

function pngSize(b64: string): { width: number; height: number } {
  const bytes = Buffer.from(b64.slice(0, 64), 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function cartWithTwoMugs(page: Page, url: string) {
  await page.goto(`${url}/products.html`);
  const add = page.getByTestId('product-card-1').getByRole('button', { name: 'Add to cart' });
  for (let i = 0; i < 2; i++) {
    const res = page.waitForResponse((r) => r.url().endsWith('/api/cart') && r.request().method() === 'POST');
    await add.click();
    await res;
  }
}

test.describe('bug-checkpoints', () => {
  test('captures an open blur-sensitive dropdown', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/dropdown.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Sort by' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();

    await trigger(sw, page);
    // The page did not lose focus, so the menu is still open behind the frozen image.
    await expect(page.locator('ul.menu')).toBeAttached();
    const option = (await page.locator('li', { hasText: 'Price: high to low' }).boundingBox())!;
    await drag(page, option);
    await expect(page.locator('str-checkpoint')).toHaveAttribute('data-snapped', "option 'Price: high to low'");
    await page.keyboard.type('Should be sorted by price, high first');
    await page.keyboard.press('Enter');
    await closed(sw);

    const rec = await stopRecording(sw);
    expect(rec.checkpoints).toHaveLength(1);
    expect(rec.checkpoints[0]!.actual.text).toBe('Price: high to low');
  });

  test('dragging over the total highlights the cell and adds no steps', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await cartWithTwoMugs(page, fixture.url);
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page.getByTestId('cart-total')).toHaveText('$0');
    await startRecording(sw, page);

    await trigger(sw, page);
    const before = (await uiState(sw)).recording.steps;
    const cell = (await page.getByTestId('cart-total').boundingBox())!;
    await drag(page, cell);
    await expect(page.locator('str-checkpoint')).toHaveAttribute('data-snapped', /cell/);
    await page.keyboard.press('Escape');
    await closed(sw);
    expect((await uiState(sw)).recording.steps).toBe(before);

    const rec = await stopRecording(sw);
    expect(userSteps(rec)).toHaveLength(0);
    expect(rec.checkpoints).toHaveLength(0);
  });

  test('saves actual and expected, context-only checkpoints, and cancels', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await cartWithTwoMugs(page, fixture.url);
    await startRecording(sw, page);
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page.getByTestId('cart-total')).toHaveText('$0');

    // 1: the bug, with an expected result.
    await trigger(sw, page);
    const cell = (await page.getByTestId('cart-total').boundingBox())!;
    await drag(page, cell);
    await page.keyboard.type('Total should be $42');
    await page.keyboard.press('Enter');
    await closed(sw);

    // 2: context only.
    await trigger(sw, page);
    await drag(page, (await page.getByRole('heading', { name: 'Cart' }).boundingBox())!);
    await page.keyboard.press('Enter');
    await closed(sw);

    // 3: cancelled.
    await trigger(sw, page);
    await drag(page, (await page.getByTestId('checkout-button').boundingBox())!);
    await page.keyboard.press('Escape');
    await closed(sw);

    const rec = await stopRecording(sw);
    expect(rec.checkpoints).toHaveLength(2);
    const [bug, context1] = rec.checkpoints;
    const cartClick = userSteps(rec).find((s) => s.kind === 'click')!;
    expect(bug).toMatchObject({ id: 1, afterStep: cartClick.index, expected: 'Total should be $42', contextOnly: false, actual: { text: '$0', visible: true } });
    expect(bug!.actual.html).toContain('data-testid="cart-total"');
    expect(renderLocator(bug!.target.locators[0]!)).toBe("getByTestId('cart-total')");
    for (const l of bug!.target.locators) expect(JSON.stringify(l)).not.toContain('$0');
    expect(context1).toMatchObject({ id: 2, contextOnly: true });
    expect(context1!.expected).toBeUndefined();

    const images = await sw.evaluate((ids) => (globalThis as any).str.store.getImages(ids), [bug!.screenshots.region, bug!.screenshots.viewport]);
    const region = images[bug!.screenshots.region];
    const viewport = images[bug!.screenshots.viewport];
    expect(region && viewport).toBeTruthy();
    const v = pngSize(viewport);
    const r = pngSize(region);
    expect(v.width).toBeLessThanOrEqual(1280);
    const css = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    expect(v.width / v.height).toBeCloseTo(css.w / css.h, 1);
    // The crop is the cell: same proportions as its box on the page.
    expect(r.width / r.height).toBeCloseTo(cell.width / cell.height, 0);
    expect(r.width).toBeLessThan(v.width);
  });

  test('a toast that disappears after the freeze can still be selected', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/toast.html`);
    await startRecording(sw, page);
    await page.getByRole('button', { name: 'Save' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    const box = (await toast.boundingBox())!;

    await trigger(sw, page);
    await expect(toast).toHaveCount(0, { timeout: 3000 });
    await drag(page, box);
    await expect(page.locator('str-checkpoint')).toHaveAttribute('data-panel', 'open');
    await page.keyboard.type('Should say Saved');
    await page.keyboard.press('Enter');
    await closed(sw);

    const rec = await stopRecording(sw);
    const [cp] = rec.checkpoints;
    expect(cp!.actual.text).toBe('Saved with errors');
    expect(cp!.target.locators.length).toBeGreaterThan(0);
    for (const l of cp!.target.locators) expect(l.unverified).toBe(true);
    expect(cp!.target.locators.some((l) => l.kind === 'css' && l.selector.includes('toast'))).toBe(true);
  });
});
