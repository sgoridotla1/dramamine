import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lets the plugin's monitor wake the agent: the MCP server writes `<claude pid>.json` when it starts
 * and appends a line to `<claude pid>.events` for each recording the user sends while nobody waits.
 * The monitor, a sibling process of the same Claude Code session, finds the files by walking up its
 * own parent processes, and prints new lines, which Claude Code delivers to the session.
 */

export const SESSIONS_DIR = join(tmpdir(), 'str-agent');

export function sessionPaths(claudePid: number, dir = SESSIONS_DIR) {
  return { info: join(dir, `${claudePid}.json`), events: join(dir, `${claudePid}.events`) };
}

/** Written by the MCP server, whose parent is the Claude Code process. */
export function registerSession(info: { port: number; cwd: string }, claudePid = process.ppid, dir = SESSIONS_DIR): { event: (line: string) => void; remove: () => void } {
  mkdirSync(dir, { recursive: true });
  const paths = sessionPaths(claudePid, dir);
  writeFileSync(paths.info, JSON.stringify({ ...info, pid: process.pid }));
  if (!existsSync(paths.events)) writeFileSync(paths.events, '');
  return {
    event: (line) => appendFileSync(paths.events, `${line.replace(/\n/g, ' ')}\n`),
    remove: () => {
      rmSync(paths.info, { force: true });
      rmSync(paths.events, { force: true });
    },
  };
}

export function parentPid(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** The events file of the nearest ancestor that registered a session, if any. */
export function findEventsFile(startPid: number, getParent = parentPid, dir = SESSIONS_DIR, maxDepth = 12): string | null {
  for (let pid: number | null = startPid, i = 0; pid && i < maxDepth; pid = getParent(pid), i++) {
    const paths = sessionPaths(pid, dir);
    if (existsSync(paths.info)) return paths.events;
  }
  return null;
}

/** Calls `onLine` for each complete line appended to `file` after this call. */
export function followFile(file: string, onLine: (line: string) => void, everyMs = 500): () => void {
  let offset = existsSync(file) ? statSync(file).size : 0;
  let partial = '';
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) onLine(l);
  }, everyMs);
  return () => clearInterval(timer);
}
