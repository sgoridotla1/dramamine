import { chromium } from '@playwright/test';
import { EXTENSION_PATH, expect, test } from './fixtures';
import { getStoredRecording, listRecordings, startRecording, stopRecording } from './helpers';

test.describe('redaction and storage', () => {
  test('secrets never reach the stored recording', async ({ context, sw, fixture }) => {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/form.html`);
    await startRecording(sw, page);
    await page.getByLabel('Username').pressSequentially('alice');
    await page.getByLabel('Password').click();
    await page.getByLabel('Password').pressSequentially('hunter2');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('status')).toContainText('Welcome alice');
    await page.waitForTimeout(200);
    const { id } = await stopRecording(sw);

    const stored = (await getStoredRecording(sw, id))!;
    const json = JSON.stringify(stored);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('secret-session-token');
    expect(json).not.toContain('tok_live_9f8e7d6c5b4a');
    expect(json).not.toContain('rt_123');
    const login = stored.network.find((n) => n.url.endsWith('/api/login'))!;
    expect(login.requestHeaders?.authorization).toBeUndefined();
    expect(login.responseBody?.text).toContain('"accessToken":"[redacted]"');
    // password field + password in the body + authorization header + two tokens in the response
    expect(stored.redactions).toBeGreaterThanOrEqual(5);
  });

  test('a recording survives a browser restart', async ({ fixture }, testInfo) => {
    const userDataDir = testInfo.outputPath('profile');
    const launch = () =>
      chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        viewport: null,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--window-size=1280,860'],
      });

    const first = await launch();
    const sw1 = first.serviceWorkers()[0] ?? (await first.waitForEvent('serviceworker'));
    const page = await first.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw1, page);
    await page.click('#create');
    await page.waitForTimeout(150);
    const { id } = await stopRecording(sw1);
    await first.close();

    const second = await launch();
    try {
      const sw2 = second.serviceWorkers()[0] ?? (await second.waitForEvent('serviceworker'));
      await expect.poll(async () => (await listRecordings(sw2)).map((r) => r.id)).toContain(id);
    } finally {
      await second.close();
    }
  });
});
