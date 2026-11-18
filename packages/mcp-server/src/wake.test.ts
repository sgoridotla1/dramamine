import { describe, expect, it } from 'vitest';
import { typeIntoPane } from './wake';

describe('waking a session in tmux', () => {
  it('stashes the draft, types the prompt on one line and submits it', async () => {
    const calls: string[][] = [];
    await typeIntoPane('%3', 'STR: the user sent\nrec_1', async (a) => void calls.push(a), async () => {});
    expect(calls).toEqual([
      ['send-keys', '-t', '%3', 'C-s'],
      ['send-keys', '-t', '%3', '-l', '--', 'STR: the user sent rec_1'],
      ['send-keys', '-t', '%3', 'Enter'],
    ]);
  });
});
