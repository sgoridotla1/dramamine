import { findEventsFile, followFile } from './session-files';

/**
 * The plugin's monitor: runs in the background of every Claude Code session and prints one line per
 * recording the user sends from Chrome, which wakes the agent. It waits for this session's MCP server
 * to register, and re-finds it if the server restarts.
 */

const FIND_EVERY_MS = 2000;

let current: { file: string; stop: () => void } | null = null;

function attach(): void {
  const file = findEventsFile(process.pid);
  if (file === current?.file) return;
  current?.stop();
  current = file ? { file, stop: followFile(file, (line) => process.stdout.write(`${line}\n`)) } : null;
}

attach();
setInterval(attach, FIND_EVERY_MS);
