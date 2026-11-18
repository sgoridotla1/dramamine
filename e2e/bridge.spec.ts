import type { BrowserContext, Page, Worker } from '@playwright/test';
import { EXTENSION_ORIGIN } from '@str/shared';
import { Bridge } from '../packages/mcp-server/src/bridge';
import { expect, test } from './fixtures';
import { sendToAgent as send, startRecording, stopRecording, tabIdOf } from './helpers';

/** A bridge whose consent page opens as a tab in the test browser. */
function bridgeFor(context: BrowserContext, cwd: string) {
  const pages: Page[] = [];
  const bridge = new Bridge({
    cwd,
    extensionOrigin: EXTENSION_ORIGIN,
    consentTimeoutMs: 20_000,
    openUrl: async (url) => {
      const p = await context.newPage();
      pages.push(p);
      await p.goto(url);
      return true;
    },
  });
  return { bridge, pages, lastPage: () => pages[pages.length - 1]! };
}

async function makeRecording(sw: Worker, context: BrowserContext, url: string, button: string) {
  const page = await context.newPage();
  await page.goto(`${url}/misc.html`);
  await startRecording(sw, page);
  await page.click(button);
  await page.waitForTimeout(150);
  const rec = await stopRecording(sw);
  await page.close();
  return rec;
}

/** Connects a bridge: waits for its consent page and approves it. */
async function connect(b: ReturnType<typeof bridgeFor>, appUrl?: string) {
  const connecting = b.bridge.ensureConnected(appUrl);
  await expect.poll(() => b.lastPage()?.url() ?? '').toContain('/connect.html');
  const consent = b.lastPage();
  await expect(consent.getByRole('heading', { name: 'Connect a coding agent?' })).toBeVisible();
  await consent.getByRole('button', { name: /^Connect/ }).click();
  await connecting;
  return consent;
}

async function killServiceWorker(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets' as any)) as any;
  const target = targetInfos.find((t: any) => t.type === 'service_worker' && t.url.startsWith(EXTENSION_ORIGIN));
  await cdp.send('Target.closeTarget' as any, { targetId: target.targetId });
  await page.close();
}

test.describe('agent bridge', () => {
  test('connect page shows the session and the app; approving opens the app and shares nothing yet', async ({ context, fixture }) => {
    const b = bridgeFor(context, '/Users/dev/shop');
    try {
      const appUrl = `${fixture.url}/products.html`;
      const connecting = b.bridge.ensureConnected(appUrl);
      await expect.poll(() => b.lastPage()?.url() ?? '').toContain('/connect.html');
      const consent = b.lastPage();
      await expect(consent.getByTestId('cwd')).toHaveText('/Users/dev/shop');
      await expect(consent.getByTestId('app-url')).toHaveText(appUrl);
      await expect(consent.getByText('Send to shop')).toBeVisible();
      await consent.getByRole('button', { name: 'Connect and open app' }).click();
      await expect(connecting).resolves.toBe(true);
      // The consent tab turns into the app.
      await expect(consent).toHaveURL(appUrl);
      expect(await b.bridge.request('listRecordings', {})).toEqual([]);
    } finally {
      await b.bridge.close();
    }
  });

  test('denying fails the pending call with a declined error', async ({ context }) => {
    const b = bridgeFor(context, '/Users/dev/shop');
    try {
      const listing = b.bridge.request('listRecordings', {}).catch((e) => e);
      await expect.poll(() => b.lastPage()?.url() ?? '').toContain('/connect.html');
      await b.lastPage().getByRole('button', { name: 'Deny' }).click();
      expect(await listing).toMatchObject({ code: 'declined' });
    } finally {
      await b.bridge.close();
    }
  });

  test('the side panel shows the waiting agent and sends the recording it just stopped', async ({ context, sw, extensionId, fixture }) => {
    const b = bridgeFor(context, '/Users/dev/shop');
    try {
      await connect(b);
      const app = await context.newPage();
      await app.goto(`${fixture.url}/misc.html`);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${await tabIdOf(sw, app)}`);
      await expect(panel.getByTestId('agent')).toContainText('connected');

      const next = b.bridge.nextRecording(30_000);
      await expect(panel.getByTestId('waiting')).toContainText('The agent in shop is waiting');
      await expect(panel.getByTestId('agent')).toContainText('waiting for a recording');

      await panel.getByRole('button', { name: 'Start recording' }).click();
      await app.bringToFront();
      await app.click('#fail');
      await expect.poll(async () => panel.getByTestId('counts').textContent()).toContain('1 step,');
      await panel.bringToFront();
      await panel.getByRole('button', { name: 'Stop recording' }).click();
      await expect(panel.getByText('Recording saved')).toBeVisible();
      await panel.getByTestId('recorder').getByRole('button', { name: 'Send to shop' }).click();

      const id = await next;
      expect(id).toMatch(/^rec_/);
      await expect(panel.getByTestId('message')).toContainText('to the agent in shop');
      await expect(panel.getByTestId('recording').getByRole('button', { name: 'Send again to shop' })).toBeVisible();
      await expect(panel.getByTestId('agent')).toContainText('1 recording sent');
      const { recording } = await b.bridge.request('getRecording', { id: id! });
      expect(recording.steps.some((s) => s.kind === 'click')).toBe(true);
    } finally {
      await b.bridge.close();
    }
  });

  test('the side panel finds a running session, connects with one click, and the send wakes the agent', async ({ context, sw, extensionId, fixture }) => {
    const b = bridgeFor(context, '/Users/dev/shop');
    try {
      // The MCP server listens from startup; no tool was called yet.
      await b.bridge.listen();
      const unclaimed: string[] = [];
      b.bridge.onUnclaimedRecording = (r) => unclaimed.push(r.id);

      const app = await context.newPage();
      await app.goto(`${fixture.url}/misc.html`);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${await tabIdOf(sw, app)}`);
      // Other sessions running on this machine may be listed too; look only at this one.
      const found = panel.locator('[data-testid="available-agent"][data-cwd="/Users/dev/shop"]');
      await expect(found).toContainText('started just now');
      await found.getByRole('button', { name: 'Connect' }).click();
      await expect.poll(() => b.bridge.connected).toBe(true);
      await expect(panel.locator('[data-testid="agent"][data-cwd="/Users/dev/shop"]')).toContainText('connected');
      await expect(found).toHaveCount(0);
      expect(b.pages).toHaveLength(0);

      await panel.getByRole('button', { name: 'Start recording' }).click();
      await app.bringToFront();
      await app.click('#fail');
      await expect.poll(async () => panel.getByTestId('counts').textContent()).toContain('1 step,');
      await panel.bringToFront();
      await panel.getByRole('button', { name: 'Stop recording' }).click();
      await panel.getByTestId('recorder').getByRole('button', { name: 'Send to shop' }).click();

      await expect.poll(() => unclaimed).toHaveLength(1);
      await expect(b.bridge.nextRecording(1000)).resolves.toBe(unclaimed[0]);
    } finally {
      await b.bridge.close();
    }
  });

  test('lists the 3 most recent agents, shows all on request, and searches by folder', async ({ context, sw, extensionId }) => {
    // Sessions running on this machine may be listed too, so there are at least four.
    const bridges = ['alpha', 'bravo', 'charlie', 'delta'].map((n) => bridgeFor(context, `/e2e/agents/${n}-repo`));
    try {
      for (const b of bridges) await b.bridge.listen();
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      const rows = panel.locator('[data-testid="available-agent"], [data-testid="agent"]');
      const toggle = panel.getByTestId('agents-toggle');
      await expect(toggle).toHaveText(/^Show all \d+ agents$/);
      await expect(rows).toHaveCount(3);
      const total = Number((await toggle.textContent())!.match(/\d+/)![0]);
      expect(total).toBeGreaterThanOrEqual(4);

      await toggle.click();
      await expect(rows).toHaveCount(total);
      await expect(toggle).toHaveText('Show fewer');

      const search = panel.getByTestId('agent-search');
      await search.pressSequentially('charl');
      await expect(search).toBeFocused();
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText('charlie-repo');
      await search.fill('no-such-folder');
      await expect(panel.getByTestId('no-agent-match')).toHaveText('No agents match "no-such-folder".');
      await panel.getByRole('button', { name: 'Clear search' }).click();
      await expect(rows).toHaveCount(total);
    } finally {
      for (const b of bridges) await b.bridge.close();
    }
  });

  test('reconnects after a service worker restart without a new prompt; sessions are isolated', async ({ context, sw, fixture }) => {
    const one = await makeRecording(sw, context, fixture.url, '#create');
    const two = await makeRecording(sw, context, fixture.url, '#fail');

    const A = bridgeFor(context, '/repo/a');
    const B = bridgeFor(context, '/repo/b');
    try {
      await connect(A);
      await connect(B);
      await send(sw, '/repo/a', one.id);
      await send(sw, '/repo/b', two.id);
      await expect(A.bridge.nextRecording(5000)).resolves.toBe(one.id);
      await expect(B.bridge.nextRecording(5000)).resolves.toBe(two.id);
      expect((await A.bridge.request('listRecordings', {})).map((r) => r.id)).toEqual([one.id]);

      // Each session sees only what was sent to it, enforced by the extension.
      await expect(A.bridge.request('getRecording', { id: two.id })).rejects.toMatchObject({ code: 'not-shared' });
      expect((await B.bridge.request('getRecording', { id: two.id })).recording.id).toBe(two.id);

      // Restart the service worker between tool calls.
      await killServiceWorker(context);
      await expect.poll(() => A.bridge.connected).toBe(false);
      const pagesBefore = A.pages.length;
      const again = await A.bridge.request('listRecordings', {});
      expect(again.map((r) => r.id)).toEqual([one.id]);
      // If a page had to be opened to wake the extension, it reconnected silently instead of prompting.
      for (const p of A.pages.slice(pagesBefore)) {
        if (!p.isClosed()) await expect(p.getByTestId('result')).toContainText('connected again');
      }
      await expect.poll(() => B.bridge.connected, { timeout: 15_000 }).toBe(true);
      expect((await B.bridge.request('listRecordings', {})).map((r) => r.id)).toEqual([two.id]);
    } finally {
      await A.bridge.close();
      await B.bridge.close();
    }
  });
});
