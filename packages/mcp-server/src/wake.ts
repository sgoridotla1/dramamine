import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Wakes an idle Claude Code session that runs inside tmux by typing a prompt into its pane:
 * stash the user's draft (Ctrl+S), type the text, press Enter.
 */

const STASH_KEY = 'C-s';
const SETTLE_MS = 300;
const SUBMIT_SETTLE_MS = 500;

export type Tmux = (args: string[]) => Promise<unknown>;

const run = promisify(execFile);
export const tmux: Tmux = (args) => run('tmux', args, { timeout: 10_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function typeIntoPane(pane: string, text: string, exec: Tmux = tmux, wait = sleep): Promise<void> {
  await exec(['send-keys', '-t', pane, STASH_KEY]);
  await wait(SETTLE_MS);
  await exec(['send-keys', '-t', pane, '-l', '--', text.replace(/\s*\n\s*/g, ' ')]);
  await wait(SUBMIT_SETTLE_MS);
  await exec(['send-keys', '-t', pane, 'Enter']);
}
