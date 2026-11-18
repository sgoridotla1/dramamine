import type { Step } from '@str/shared';
import { renderLocator } from '@str/shared';
import { expect, test } from './fixtures';
import { getStoredRecording, startRecording, stopRecording, tabIdOf, uiState, userSteps } from './helpers';

test.describe('session-recording', () => {
  test('starting a recording attaches and a second recording is refused', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    const tabId = await startRecording(sw, page);
    expect((await uiState(sw)).recording.tabId).toBe(tabId);

    const other = await context.newPage();
    await other.goto(`${fixture.url}/form.html`);
    const otherId = await tabIdOf(sw, other);
    const second = await sw.evaluate((t) => (globalThis as any).str.controller.startRecording(t), otherId);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('Already recording');
    expect(second.error).toContain('Misc');

    // The debugger works: console capture reaches the recording.
    await page.click('#throw');
    await page.waitForTimeout(200);
    const rec = await stopRecording(sw);
    expect(rec.console.some((c) => c.level === 'exception')).toBe(true);
    expect((await uiState(sw)).recording).toBeNull();
  });

  test('recording is refused on browser pages', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto('about:blank#str-refuse');
    const tabId = await tabIdOf(sw, page);
    const res = await sw.evaluate((t) => (globalThis as any).str.controller.startRecording(t), tabId);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not possible on this page');
  });

  test('records input once, select, Enter and clicks with unique locators', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/form.html`);
    await startRecording(sw, page);

    await page.getByLabel('Username').pressSequentially('alice', { delay: 30 });
    await page.getByLabel('Password').click();
    await page.getByLabel('Password').pressSequentially('hunter2');
    // A trusted selection: typeahead on the focused native select (selectOption() dispatches untrusted events).
    await page.getByLabel('Country').focus();
    await page.keyboard.type('Israel');
    await page.getByLabel('Username').click();
    await page.getByLabel('Username').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Welcome alice from Israel');
    const rec = await stopRecording(sw);

    const steps = userSteps(rec);
    const inputs = steps.filter((s) => s.kind === 'input');
    expect(inputs.filter((s) => s.kind === 'input' && s.value === 'alice')).toHaveLength(1);
    // Role + name ranks before label (element-locators priority order); the label locator is an alternative.
    expect(inputs[0]!.target.locators.map(renderLocator).slice(0, 2)).toEqual(["getByRole('textbox', { name: 'Username' })", "getByLabel('Username')"]);

    const password = inputs.find((s) => s.kind === 'input' && s.redacted);
    expect(password).toMatchObject({ value: '********', redacted: true });
    expect(JSON.stringify(rec)).not.toContain('hunter2');
    expect(rec.redactions).toBeGreaterThanOrEqual(1);

    const select = steps.find((s) => s.kind === 'select');
    expect(select).toMatchObject({ value: 'il', label: 'Israel' });

    const enter = steps.findIndex((s) => s.kind === 'key' && s.key === 'Enter');
    expect(enter).toBeGreaterThan(-1);
    // No click steps for focusing fields.
    expect(steps.filter((s) => s.kind === 'click')).toHaveLength(0);
  });

  test('scopes repeated buttons and every click locator is unique on the page', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/products.html`);
    await expect(page.getByTestId('product-card-12')).toBeVisible();
    await startRecording(sw, page);
    await page.getByTestId('product-card-3').getByRole('button', { name: 'Add to cart' }).click();
    await page.waitForTimeout(100);
    const rec = await stopRecording(sw);

    const [click] = userSteps(rec) as Extract<Step, { kind: 'click' }>[];
    expect(click!.kind).toBe('click');
    expect(renderLocator(click!.target.locators[0]!)).toBe("getByTestId('product-card-3').getByRole('button', { name: 'Add to cart' })");
    expect(click!.target.description).toBe("button 'Add to cart'");
    expect(await page.getByTestId('product-card-3').getByRole('button', { name: 'Add to cart' }).count()).toBe(1);
  });

  test('records navigation as consequences, SPA routes and standalone navigations', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/products.html`);
    await startRecording(sw, page);

    await page.getByRole('link', { name: 'Cart' }).click();
    await page.waitForURL('**/cart.html');
    await page.goto(`${fixture.url}/spa.html`);
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.waitForTimeout(1200);
    await page.evaluate(() => history.pushState({}, '', '/spa.html?tab=hidden'));
    await page.waitForTimeout(200);
    const rec = await stopRecording(sw);

    const steps = userSteps(rec);
    const cartClick = steps.find((s) => s.kind === 'click' && s.target.description === "link 'Cart'");
    expect(cartClick).toMatchObject({ navigation: `${fixture.url}/cart.html` });
    expect(steps.find((s) => s.kind === 'navigate' && s.url === `${fixture.url}/spa.html`)).toBeTruthy();
    const settings = steps.find((s) => s.kind === 'click' && s.target.description === "button 'Settings'");
    expect(settings).toMatchObject({ navigation: `${fixture.url}/spa.html?tab=settings` });
    expect(steps.find((s) => s.kind === 'navigate' && s.url.endsWith('?tab=hidden'))).toBeTruthy();
    // Steps are numbered in order.
    expect(rec.steps.map((s) => s.index)).toEqual(rec.steps.map((_, i) => i));
  });

  test('links an uncaught exception to the click that caused it', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    await page.click('#create');
    await page.waitForTimeout(100);
    await page.click('#throw');
    await page.dblclick('#dbl');
    await page.waitForTimeout(200);
    const rec = await stopRecording(sw);

    const dbl = userSteps(rec).filter((s) => 'target' in s && s.target.description === "button 'Double me'");
    expect(dbl.map((s) => s.kind)).toEqual(['dblclick']);

    const crash = userSteps(rec).find((s) => s.kind === 'click' && s.target.description === "button 'Crash'")!;
    const exception = rec.console.find((c) => c.level === 'exception')!;
    expect(exception.text).toContain("Cannot read properties of undefined (reading 'title')");
    expect(exception.step).toBe(crash.index);
    expect(exception.stack?.[0]).toContain('misc.html');
  });

  test('captures fetch/XHR with status, duration and capped bodies; ignores static assets', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    await page.click('#create');
    await expect(page.getByTestId('misc-out')).toHaveText('created 201');
    await page.click('#fail');
    await expect(page.getByTestId('misc-out')).toHaveText('status 500');
    await page.click('#big');
    await expect(page.getByTestId('misc-out')).toHaveText(/^big/);
    await page.goto(`${fixture.url}/products.html`);
    await expect(page.getByTestId('product-card-1')).toBeVisible();
    await page.waitForTimeout(200);
    const rec = await stopRecording(sw);

    const created = rec.network.find((n) => n.url.endsWith('/api/created'))!;
    const createClick = userSteps(rec).find((s) => s.kind === 'click' && s.target.description === "button 'Create item'")!;
    expect(created).toMatchObject({ method: 'POST', status: 201, resourceType: 'fetch', step: createClick.index });
    expect(created.durationMs).toBeGreaterThanOrEqual(0);

    const failed = rec.network.find((n) => n.url.endsWith('/api/fail'))!;
    expect(failed.status).toBe(500);
    expect(failed.responseBody?.text).toContain('E_FIRE');

    const big = rec.network.find((n) => n.url.endsWith('/api/big'))!;
    expect(big.responseBody?.truncated?.originalSize).toBeGreaterThan(50 * 1024);
    expect(big.responseBody!.text.length).toBeLessThan(11 * 1024);
    expect(big.responseBody!.text).toContain('[truncated:');

    expect(rec.network.some((n) => n.url.endsWith('/api/products'))).toBe(true);
    expect(rec.network.some((n) => n.url.endsWith('.svg') || n.url.endsWith('.css'))).toBe(false);
  });

  test('adds notes for new tabs and file uploads', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open checkout in new tab' }).click();
    await (await popup).waitForLoadState();
    page.on('filechooser', () => {});
    await page.getByLabel('Attachment').click();
    await page.waitForTimeout(200);
    const rec = await stopRecording(sw);

    expect(rec.notes.some((n) => n.text.includes('new tab') && n.text.includes('checkout.html'))).toBe(true);
    expect(rec.notes.some((n) => n.text.includes('file upload'))).toBe(true);
  });

  test('injecting the content script again (tabs that lost it) does not record steps twice', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    const tabId = await tabIdOf(sw, page);
    await sw.evaluate((t) => chrome.scripting.executeScript({ target: { tabId: t, frameIds: [0] }, files: ['content.js'] }), tabId);
    await startRecording(sw, page);
    await page.click('#create');
    await page.waitForTimeout(150);
    const rec = await stopRecording(sw);
    expect(userSteps(rec).filter((s) => s.kind === 'click')).toHaveLength(1);
  });

  test('closing the tab stops and stores an interrupted recording with its steps', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    await page.click('#create');
    await page.click('#fail');
    await page.waitForTimeout(200);
    await page.close();
    await expect.poll(async () => (await uiState(sw)).recording).toBeNull();

    const [summary] = await sw.evaluate(() => (globalThis as any).str.store.listRecordings());
    expect(summary.interrupted).toBe(true);
    const rec = (await getStoredRecording(sw, summary.id))!;
    expect(rec.interrupted?.reason).toContain('closed');
    expect(userSteps(rec).map((s) => (s as { target?: { description: string } }).target?.description)).toEqual(["button 'Create item'", "button 'Load report'"]);
    expect((await uiState(sw)).lastError).toContain('Recording stopped');
  });
});
