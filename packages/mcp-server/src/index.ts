import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXTENSION_ORIGIN } from '@str/shared';
import { Bridge } from './bridge';
import { openInChrome } from './open-url';
import { createServer, recordingSentText } from './server';
import { processClient, processStartedAt, registerSession } from './session-files';
import { typeIntoPane } from './wake';

const bridge = new Bridge({
  cwd: process.cwd(),
  extensionOrigin: process.env.STR_EXTENSION_ORIGIN ?? EXTENSION_ORIGIN,
  openUrl: openInChrome,
  // stdout carries the MCP protocol; diagnostics go to stderr.
  log: (msg) => process.stderr.write(`[str] ${msg}\n`),
  startedAt: processStartedAt(process.ppid) ?? Date.now(),
  ...(() => {
    const client = processClient(process.ppid);
    return client ? { client } : {};
  })(),
});

// Listen right away, so the side panel can find and connect to this session before the agent asks.
const port = await bridge.listen().catch((e) => (process.stderr.write(`[str] ${e instanceof Error ? e.message : String(e)}\n`), 0));

const server = createServer(bridge);
await server.connect(new StdioServerTransport());

// The plugin's monitor tails this session's events file and wakes the agent; channels are not always allowed.
let session: ReturnType<typeof registerSession> | null = null;
try {
  session = registerSession({ port, cwd: process.cwd() });
} catch (e) {
  process.stderr.write(`[str] could not register the session for the monitor: ${e instanceof Error ? e.message : String(e)}\n`);
}
// Inside tmux, typing into Claude's own pane always wakes it; otherwise channels and the monitor try.
const pane = process.env.TMUX_PANE;
const notifyChannel = bridge.onUnclaimedRecording;
bridge.onUnclaimedRecording = (r) => {
  const fallback = () => {
    notifyChannel?.(r);
    session?.event(recordingSentText(r));
  };
  if (!pane) return fallback();
  typeIntoPane(pane, recordingSentText(r)).catch((e) => {
    process.stderr.write(`[str] could not type into tmux pane ${pane}: ${e instanceof Error ? e.message : String(e)}\n`);
    fallback();
  });
};

const shutdown = async () => {
  session?.remove();
  await bridge.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
