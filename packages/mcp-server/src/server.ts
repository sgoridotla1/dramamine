import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CheckpointCheckSchema, GlobalCheckSchema, isWebUrl, STR_VERSION } from '@str/shared';
import { z } from 'zod';
import { BridgeError, type Bridge } from './bridge';
import { INSTRUCTIONS, TOOL_DESCRIPTIONS } from './instructions';
import { recordingContent, renderRecordingList, replayContent, type Content } from './render';

type ToolResult = { content: Content[]; isError?: boolean };

export const DEFAULT_WAIT_SECONDS = 600;
const PROGRESS_EVERY_MS = 15_000;

async function guard(fn: () => Promise<Content[]>): Promise<ToolResult> {
  try {
    return { content: await fn() };
  } catch (e) {
    const message = e instanceof BridgeError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

export type AgentLink = Pick<Bridge, 'request' | 'ensureConnected' | 'nextRecording' | 'sentRecordings'> & Partial<Pick<Bridge, 'onUnclaimedRecording'>>;

/** What wakes the agent (channel event or monitor line) when the user sends a recording nobody waits for. */
export function recordingSentText(r: { id: string; title?: string }): string {
  return `STR: the user sent the bug recording "${r.title ?? r.id}" (${r.id}) from Chrome. Call wait_for_recording to get it (it returns right away), then reproduce the bug with a baseline replay, fix it and verify with a replay. If you already have ${r.id}, ignore this.`;
}

/** The event pushed into an idle Claude Code session (channels) when the user sends a recording. */
export function recordingSentEvent(r: { id: string; title?: string }) {
  return { method: 'notifications/claude/channel', params: { content: recordingSentText(r), meta: { recording_id: r.id } } };
}

const SEND_HINT = 'Ask the user to reproduce the bug in Chrome, mark what is wrong with a checkpoint (Alt+Shift+S) and click "Send to agent" in the STR side panel. Then call wait_for_recording.';

export function createServer(bridge: AgentLink): McpServer {
  const server = new McpServer(
    { name: 'str', version: STR_VERSION },
    // claude/channel: Claude Code started with --channels (or the development flag) receives recordingSentEvent.
    { instructions: INSTRUCTIONS, capabilities: { experimental: { 'claude/channel': {} } } },
  );
  if ('onUnclaimedRecording' in bridge) {
    bridge.onUnclaimedRecording = (r) => {
      // Other clients ignore unknown notifications; nothing to do if the transport is gone.
      void server.server.notification(recordingSentEvent(r) as never).catch(() => {});
    };
  }

  server.registerTool(
    'connect_browser',
    {
      title: 'Connect to Chrome',
      description: TOOL_DESCRIPTIONS.connect_browser,
      inputSchema: { url: z.string().optional().describe('http(s) URL of the app under test, opened for the user') },
    },
    ({ url }) =>
      guard(async () => {
        if (url !== undefined && !isWebUrl(url)) throw new BridgeError('bad-request', `Only http and https URLs can be opened, got ${url}`);
        const approved = await bridge.ensureConnected(url);
        if (!approved && url) await bridge.request('openTab', { url });
        const sent = bridge.sentRecordings.length;
        return [{ type: 'text', text: `Connected to Chrome${url ? ` and opened ${url}` : ''}.${sent ? ` The user has sent ${sent} recording(s) so far; see list_recordings.` : ''} ${SEND_HINT}` }];
      }),
  );

  server.registerTool(
    'wait_for_recording',
    {
      title: 'Wait for a recording',
      description: TOOL_DESCRIPTIONS.wait_for_recording,
      inputSchema: { timeoutSeconds: z.number().int().positive().max(3600).optional().describe(`How long to wait (default ${DEFAULT_WAIT_SECONDS})`) },
    },
    ({ timeoutSeconds }, extra) =>
      guard(async () => {
        await bridge.ensureConnected();
        const timeoutMs = (timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
        // Progress notifications keep clients that reset their timeout on progress from giving up.
        const progressToken = extra._meta?.progressToken;
        const started = Date.now();
        const progress =
          progressToken === undefined
            ? undefined
            : setInterval(() => {
                const elapsed = Date.now() - started;
                void extra
                  .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: elapsed, total: timeoutMs, message: 'Waiting for the user to send a recording from Chrome' } })
                  .catch(() => {});
              }, PROGRESS_EVERY_MS);
        let id: string | null;
        try {
          id = await bridge.nextRecording(timeoutMs, extra.signal);
        } finally {
          clearInterval(progress);
        }
        if (!id) return [{ type: 'text', text: `No recording was sent within ${Math.round(timeoutMs / 1000)} seconds. Ask the user whether they are still reproducing the bug, then call wait_for_recording again.` }];
        const { recording, images } = await bridge.request('getRecording', { id });
        const [log, ...rest] = recordingContent(recording, images);
        return [{ type: 'text', text: `The user sent recording ${id}.\n\n${(log as { text: string }).text}` }, ...rest];
      }),
  );

  server.registerTool('list_recordings', { title: 'List sent recordings', description: TOOL_DESCRIPTIONS.list_recordings, inputSchema: {} }, () =>
    guard(async () => {
      const list = await bridge.request('listRecordings', {});
      return [{ type: 'text', text: list.length ? renderRecordingList(list) : `The user has not sent any recordings to this session yet. ${SEND_HINT}` }];
    }),
  );

  server.registerTool(
    'get_recording',
    {
      title: 'Get a recording',
      description: TOOL_DESCRIPTIONS.get_recording,
      inputSchema: {
        id: z.string().describe('Recording id from wait_for_recording or list_recordings'),
        format: z.enum(['text', 'json']).optional().describe("'text' (default): readable log with screenshots; 'json': the full structured recording"),
      },
    },
    ({ id, format }) =>
      guard(async () => {
        const { recording, images } = await bridge.request('getRecording', { id });
        if (format === 'json') return [{ type: 'text', text: JSON.stringify(recording, null, 2) }];
        return recordingContent(recording, images);
      }),
  );

  server.registerTool(
    'replay',
    {
      title: 'Replay a recording',
      description: TOOL_DESCRIPTIONS.replay,
      inputSchema: {
        id: z.string().describe('Recording id'),
        checks: z.array(CheckpointCheckSchema).optional().describe('Checks evaluated at checkpoints (compiled from the expected results)'),
        globalChecks: z.array(GlobalCheckSchema).optional().describe('Checks over the whole replay'),
        redactedValues: z.record(z.string(), z.string()).optional().describe('Values for redacted input steps, keyed by step number'),
        stepTimeoutMs: z.number().int().positive().max(60_000).optional().describe('How long each step waits for its element (default 5000)'),
        checkTimeoutMs: z.number().int().positive().max(60_000).optional().describe('How long checks retry at a checkpoint (default 5000)'),
      },
    },
    (args) =>
      guard(async () => {
        const { report, images } = await bridge.request('replay', args);
        return replayContent(report, images);
      }),
  );

  return server;
}
