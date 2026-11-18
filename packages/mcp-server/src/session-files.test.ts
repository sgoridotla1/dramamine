import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findEventsFile, followFile, registerSession, sessionPaths } from './session-files';

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

describe('session files for the monitor', () => {
  it('registers under the Claude pid and removes the files on exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'str-test-'));
    const s = registerSession({ port: 47600, cwd: '/repo' }, 4242, dir);
    s.event('STR: the user sent rec_1');
    const { info, events } = sessionPaths(4242, dir);
    expect(findEventsFile(4242, () => null, dir)).toBe(events);
    s.remove();
    expect(findEventsFile(4242, () => null, dir)).toBeNull();
    expect(info).toContain('4242.json');
  });

  it('finds the session of the nearest ancestor process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'str-test-'));
    // monitor (30) -> shell (20) -> claude (10); another session registered under 99.
    registerSession({ port: 47600, cwd: '/a' }, 10, dir);
    registerSession({ port: 47601, cwd: '/b' }, 99, dir);
    const parents: Record<number, number> = { 30: 20, 20: 10, 10: 1 };
    expect(findEventsFile(30, (p) => parents[p] ?? null, dir)).toBe(sessionPaths(10, dir).events);
    expect(findEventsFile(30, () => null, dir)).toBeNull();
  });

  it('follows only lines appended after it started, across partial writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'str-test-'));
    const file = join(dir, 'x.events');
    writeFileSync(file, 'old line\n');
    const lines: string[] = [];
    stops.push(followFile(file, (l) => lines.push(l), 20));
    appendFileSync(file, 'first\nsec');
    await expect.poll(() => lines).toEqual(['first']);
    appendFileSync(file, 'ond\n');
    await expect.poll(() => lines).toEqual(['first', 'second']);
  });
});
