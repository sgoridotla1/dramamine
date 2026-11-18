import { z } from 'zod';
import { CheckpointCheckSchema, GlobalCheckSchema } from './checks';
import { RecordingSchema, RecordingSummarySchema } from './recording';
import { ReplayReportSchema } from './report';

/**
 * Bridge protocol between the MCP server and the extension, over a localhost WebSocket.
 * To find running sessions, the extension sends `discover` and the server answers with `session-info`
 * (only the extension's origin is accepted, so web pages cannot learn the token).
 * The extension connects and sends `hello`; after `welcome`, the server sends requests
 * and the extension answers them. The extension pings periodically to stay alive.
 * When the user sends a recording from the side panel, the extension pushes `recording-sent`;
 * the server tells the extension with `waiting` whether the agent is waiting for one.
 */

export const DEFAULT_STEP_TIMEOUT_MS = 5000;
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

/** Images travel next to the JSON, keyed by blob id, as base64 PNG. */
export const ImagesSchema = z.record(z.string(), z.string());
export type Images = z.infer<typeof ImagesSchema>;

export const ReplayParamsSchema = z.object({
  id: z.string(),
  checks: z.array(CheckpointCheckSchema).default([]),
  globalChecks: z.array(GlobalCheckSchema).default([]),
  /** Values for input steps whose value was redacted at record time, keyed by step index. */
  redactedValues: z.record(z.string(), z.string()).default({}),
  stepTimeoutMs: z.number().int().positive().max(60_000).optional(),
  checkTimeoutMs: z.number().int().positive().max(60_000).optional(),
  /** Which screenshots the result carries: failed (default) / all / none. */
  images: z.enum(['failed', 'all', 'none']).default('failed'),
});
export type ReplayImageMode = z.infer<typeof ReplayParamsSchema>['images'];
export type ReplayParams = z.input<typeof ReplayParamsSchema>;
/** Replay parameters after validation, with defaults applied. */
export type ResolvedReplayParams = z.infer<typeof ReplayParamsSchema>;

export const Methods = {
  listRecordings: {
    params: z.object({}),
    result: z.array(RecordingSummarySchema),
  },
  getRecording: {
    params: z.object({ id: z.string() }),
    result: z.object({ recording: RecordingSchema, images: ImagesSchema }),
  },
  replay: {
    params: ReplayParamsSchema,
    result: z.object({ report: ReplayReportSchema, images: ImagesSchema }),
  },
  openTab: {
    params: z.object({ url: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;
export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]['result']>;

export const ERROR_CODES = ['not-shared', 'not-found', 'busy', 'bad-request', 'internal'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), token: z.string(), decision: z.enum(['approved', 'denied']), extensionVersion: z.string() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('discover') }),
  z.object({ type: z.literal('recording-sent'), id: z.string(), title: z.string().optional() }),
  z.object({
    type: z.literal('response'),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).optional(),
  }),
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), cwd: z.string() }),
  z.object({
    type: z.literal('session-info'),
    token: z.string(),
    cwd: z.string(),
    startedAt: z.number(),
    connected: z.boolean(),
    /** Where the agent session runs: in a terminal, or in an app such as the Claude desktop app. */
    client: z.enum(['terminal', 'app']).optional(),
  }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('waiting'), waiting: z.boolean() }),
  z.object({ type: z.literal('request'), id: z.number().int(), method: z.enum(['listRecordings', 'getRecording', 'replay', 'openTab']), params: z.unknown() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Query parameters of the consent page URL opened by the server. */
export interface ConnectParams {
  port: number;
  token: string;
  cwd: string;
  /** The app to open once the user connects. */
  appUrl?: string;
}

export function connectUrl(extensionOrigin: string, p: ConnectParams): string {
  const q = new URLSearchParams({ port: String(p.port), token: p.token, cwd: p.cwd, ...(p.appUrl ? { appUrl: p.appUrl } : {}) });
  return `${extensionOrigin}/connect.html?${q}`;
}

/** Only web pages can be opened for the user: no file://, javascript: or browser pages. */
export function isWebUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
