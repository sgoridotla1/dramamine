import { expect, test } from './fixtures';
import { readFileSync } from 'node:fs';
import { listRecordings, startRecording, stopRecording, tabIdOf } from './helpers';

test.describe('side panel', () => {
  test('records, lists, renames and deletes recordings', async ({ context, sw, extensionId, fixture }) => {
    const app = await context.newPage();
    await app.goto(`${fixture.url}/misc.html`);
    const tabId = await tabIdOf(sw, app);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);

    await expect(panel.getByText('No recordings yet.')).toBeVisible();
    await panel.getByRole('button', { name: 'Start recording' }).click();
    await expect(panel.getByText(/^Recording \d+:\d\d$/)).toBeVisible();

    await app.bringToFront();
    await app.click('#create');
    await expect.poll(async () => panel.getByTestId('counts').textContent()).toContain('1 step,');

    await panel.bringToFront();
    await panel.getByRole('button', { name: 'Stop recording' }).click();
    const item = panel.getByTestId('recording');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Misc');
    await expect(item).toContainText('1 step, 0 checkpoints');

    // Rename.
    await item.getByRole('button', { name: 'Rename' }).click();
    const title = panel.getByRole('textbox', { name: 'Recording title' });
    await title.fill('Create item fails silently');
    await title.press('Enter');
    await expect(item.locator('.title')).toHaveText('Create item fails silently');
    expect((await listRecordings(sw))[0]!.title).toBe('Create item fails silently');

    // Delete needs a confirmation click.
    await item.getByRole('button', { name: 'Delete' }).click();
    await expect(item.getByRole('button', { name: 'Confirm delete' })).toBeVisible();
    await item.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(panel.getByTestId('recording')).toHaveCount(0);
    await expect(panel.getByText('No recordings yet.')).toBeVisible();
    expect(await listRecordings(sw)).toEqual([]);
  });

  test('copies the trace and downloads the recording', async ({ context, sw, extensionId, fixture }) => {
    const app = await context.newPage();
    await app.goto(`${fixture.url}/misc.html`);
    const tabId = await tabIdOf(sw, app);
    await startRecording(sw, app);
    await app.click('#fail');
    await app.waitForTimeout(150);
    const rec = await stopRecording(sw);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
    await panel.evaluate(() => {
      (window as any).copiedText = null;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).copiedText = t);
    });
    const actions = panel.getByTestId('recording').getByTestId('recording-actions');
    // Without a connected agent, sending is offered but disabled.
    await expect(actions.getByRole('button', { name: 'Send to agent' })).toBeDisabled();

    await actions.getByRole('button', { name: 'Copy trace' }).click();
    await expect(actions.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copiedText = await panel.evaluate(() => (window as any).copiedText as string);
    expect(copiedText).toContain(`# STR: ${rec.title}`);
    expect(copiedText).toContain('/api/fail -> 500');

    const downloading = panel.waitForEvent('download');
    await actions.getByRole('button', { name: 'Download' }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/^misc-\d{4}-\d{2}-\d{2}\.dramamine\.json$/);
    const saved = JSON.parse(readFileSync((await file.path())!, 'utf8'));
    expect(saved).toMatchObject({ format: 'dramamine-recording', version: 1, recording: { id: rec.id } });
  });

  test('looks for agents only when opened and when refresh is clicked', async ({ context, sw, extensionId, fixture }) => {
    const app = await context.newPage();
    await app.goto(`${fixture.url}/misc.html`);
    const tabId = await tabIdOf(sw, app);
    const panel = await context.newPage();
    // Count the panel's agent lookups.
    await panel.addInitScript(() => {
      (window as any).lookups = 0;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      (chrome.runtime as any).sendMessage = (msg: any, ...rest: any[]) => {
        if (msg?.type === 'discover-sessions') (window as any).lookups++;
        return (send as any)(msg, ...rest);
      };
    });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
    const lookups = () => panel.evaluate(() => (window as any).lookups as number);
    await expect.poll(lookups).toBe(1);

    // State changes and page loads do not trigger lookups.
    await panel.getByRole('button', { name: 'Start recording' }).click();
    await app.bringToFront();
    await app.click('#create');
    await app.reload();
    await panel.bringToFront();
    await panel.getByRole('button', { name: 'Stop recording' }).click();
    await panel.waitForTimeout(1000);
    expect(await lookups()).toBe(1);

    await panel.getByRole('button', { name: 'Find running agents' }).click();
    await expect.poll(lookups).toBe(2);
  });

  test('explains that browser pages cannot be recorded', async ({ context, sw, extensionId }) => {
    const page = await context.newPage();
    await page.goto('about:blank#str-panel');
    const tabId = await tabIdOf(sw, page);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
    await expect(panel.getByTestId('restricted')).toContainText("Recording isn't available on this page");
    await expect(panel.getByRole('button', { name: 'Start recording' })).toBeDisabled();
  });
});
