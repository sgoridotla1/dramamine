import { EXTENSION_ID } from '@str/shared';
import { expect, test } from './fixtures';

test('extension loads with its fixed id and serves the side panel', async ({ context, extensionId, fixture }) => {
  expect(extensionId).toBe(EXTENSION_ID);

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page).toHaveTitle('Dramamine');
  expect(errors).toEqual([]);

  const app = await context.newPage();
  await app.goto(`${fixture.url}/`);
  await expect(app.getByRole('heading', { name: 'Fixture shop' })).toBeVisible();
});
