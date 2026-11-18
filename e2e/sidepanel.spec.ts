import { expect, test } from './fixtures';
import { listRecordings, tabIdOf } from './helpers';

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
