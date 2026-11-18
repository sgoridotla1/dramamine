import { expect, type Locator, type Page, type Worker } from '@playwright/test';
import type { Recording, RecordingSummary } from '@str/shared';

/** The chrome.tabs id of a Playwright page, looked up from the service worker by URL. */
export async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  const ids = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.url === url).map((t) => t.id!);
  }, page.url());
  if (ids.length !== 1) throw new Error(`expected one tab at ${page.url()}, found ${ids.length}`);
  return ids[0]!;
}

export async function startRecording(sw: Worker, page: Page): Promise<number> {
  const tabId = await tabIdOf(sw, page);
  const res = await sw.evaluate((t) => (globalThis as any).str.controller.startRecording(t), tabId);
  if (!res.ok) throw new Error(res.error);
  // Let the content script switch into record mode.
  await page.waitForTimeout(150);
  return tabId;
}

export async function stopRecording(sw: Worker): Promise<Recording> {
  const r = await sw.evaluate(() => (globalThis as any).str.controller.stopRecording());
  if (!r) throw new Error('no recording was active');
  return r as Recording;
}

export async function listRecordings(sw: Worker): Promise<RecordingSummary[]> {
  return sw.evaluate(() => (globalThis as any).str.store.listRecordings());
}

export async function getStoredRecording(sw: Worker, id: string): Promise<Recording | undefined> {
  return sw.evaluate((i) => (globalThis as any).str.store.getRecording(i), id);
}

export async function uiState(sw: Worker) {
  return sw.evaluate(() => (globalThis as any).str.controller.getState());
}

/** Steps without the synthetic initial-load step. */
export function userSteps(r: Recording) {
  return r.steps.filter((s) => s.kind !== 'initial-load');
}

export type ReplayOutcome =
  | { ok: true; report: import('@str/shared').ReplayReport; images: Record<string, string> }
  | { ok: false; code: string; message: string };

export async function replay(sw: Worker, params: import('@str/shared').ReplayParams): Promise<ReplayOutcome> {
  return sw.evaluate(async (p) => {
    try {
      const r = await (globalThis as any).str.controller.replayRecording(p);
      return { ok: true as const, ...r };
    } catch (e: any) {
      return { ok: false as const, code: e.code ?? 'internal', message: String(e.message ?? e) };
    }
  }, params);
}

export async function replayOk(sw: Worker, params: import('@str/shared').ReplayParams) {
  const r = await replay(sw, params);
  if (!r.ok) throw new Error(`replay failed: ${r.code} ${r.message}`);
  return r;
}

/** The newest page at a URL (replays open a new tab). */
export function newestPage(context: import('@playwright/test').BrowserContext, urlPart: string): Page {
  const pages = context.pages().filter((p) => p.url().includes(urlPart));
  return pages[pages.length - 1]!;
}

/** Takes a checkpoint on `target` through the same path as the keyboard shortcut. */
export async function takeCheckpoint(sw: Worker, page: Page, target: Locator, expected?: string): Promise<void> {
  const box = (await target.boundingBox())!;
  const res = await sw.evaluate(() => (globalThis as any).str.controller.triggerCheckpoint());
  if (!res.ok) throw new Error(res.error);
  await expect(page.locator('str-checkpoint')).toBeAttached();
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('str-checkpoint')).toHaveAttribute('data-panel', 'open');
  if (expected) await page.keyboard.type(expected);
  await page.keyboard.press('Enter');
  await expect.poll(() => sw.evaluate(() => (globalThis as any).str.controller.checkpointOpen())).toBe(false);
}

/** Adds the first product to the cart `times` times through the UI. */
export async function addMugs(page: Page, url: string, times = 2): Promise<void> {
  if (!page.url().endsWith('/products.html')) await page.goto(`${url}/products.html`);
  const add = page.getByTestId('product-card-1').getByRole('button', { name: 'Add to cart' });
  for (let i = 0; i < times; i++) {
    const res = page.waitForResponse((r) => r.url().endsWith('/api/cart') && r.request().method() === 'POST');
    await add.click();
    await res;
  }
}

/** What the side panel's "Send to agent" button does, for the session started in `cwd`. */
export async function sendToAgent(sw: Worker, cwd: string, id: string): Promise<void> {
  const res = await sw.evaluate(
    async ([c, i]) => {
      const str = (globalThis as any).str;
      const session = str.bridge.sessionSummaries().find((s: any) => s.cwd === c);
      if (!session) return { ok: false, error: `no agent session for ${c}` };
      return str.bridge.sendRecording(session.token, i);
    },
    [cwd, id] as const,
  );
  if (!res.ok) throw new Error(res.error);
}
