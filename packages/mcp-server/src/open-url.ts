import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Opens a URL in the user's Chrome. Launching the Chrome binary with a URL hands it to the
 * running instance, which also works for chrome-extension:// URLs.
 * Set STR_CHROME_PATH to use a different Chrome or Chromium binary.
 */

function candidates(): string[][] {
  const custom = process.env.STR_CHROME_PATH;
  if (custom) return [[custom]];
  switch (process.platform) {
    case 'darwin':
      return [
        ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
        ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ].filter(([p]) => existsSync(p!));
    case 'win32':
      return [['cmd', '/c', 'start', '""', 'chrome']];
    default:
      return [['google-chrome'], ['google-chrome-stable'], ['chromium'], ['chromium-browser']];
  }
}

function run(cmd: string[], url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd[0]!, [...cmd.slice(1), url], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function openInChrome(url: string): Promise<boolean> {
  for (const cmd of candidates()) if (await run(cmd, url)) return true;
  return false;
}
