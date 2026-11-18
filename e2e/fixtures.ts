import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, type FixtureServer } from '../packages/fixture-app/server.mjs';

export const EXTENSION_PATH = fileURLToPath(new URL('../packages/extension/dist', import.meta.url));

type TestFixtures = {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  fixture: FixtureServer;
};

type WorkerFixtures = {
  fixtureServer: FixtureServer;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureServer: [
    async ({}, use) => {
      const server = await createFixtureServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  fixture: async ({ fixtureServer }, use) => {
    fixtureServer.reset();
    await use(fixtureServer);
  },

  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // No viewport emulation: like a real user's window, so screenshots match the CSS viewport.
      viewport: null,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--window-size=1280,860'],
    });
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },

  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
