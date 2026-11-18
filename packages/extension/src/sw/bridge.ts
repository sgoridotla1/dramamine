import { DISCOVERY_PORT_COUNT, DISCOVERY_PORT_FIRST, isWebUrl, Methods, STR_VERSION, type ErrorCode, type ExtensionMessage, type MethodName, type ServerMessage, ServerMessageSchema } from '@str/shared';
import * as controller from './controller';
import { BridgeError } from './errors';
import * as store from './store';

/**
 * The extension side of the agent link. Each approved MCP server session is kept in
 * chrome.storage.session (it survives service worker restarts, not browser restarts) and
 * reconnected automatically when the service worker starts again. A session sees only the
 * recordings the user sent to it from the side panel.
 */

export interface BridgeSession {
  token: string;
  port: number;
  cwd: string;
  shared: string[];
  approvedAt: number;
}

const SESSIONS_KEY = 'bridgeSessions';
const PING_MS = 20_000;
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

interface Live {
  ws: WebSocket | null;
  connected: boolean;
  /** The agent is waiting for the user to send a recording. */
  waiting: boolean;
  ping?: ReturnType<typeof setInterval>;
  attempt: number;
  closing: boolean;
}

const live = new Map<string, Live>();
let sessionsCache: Record<string, BridgeSession> = {};
let sessionsLoaded: Promise<void> | null = null;

/**
 * Reads the stored sessions once per service worker start; after that the in-memory copy is
 * authoritative (only this worker writes it). Reloading on every call let a concurrent reload
 * replace the object another call was updating, losing a share.
 */
async function loadSessions(): Promise<Record<string, BridgeSession>> {
  sessionsLoaded ??= chrome.storage.session.get(SESSIONS_KEY).then((r) => {
    sessionsCache = { ...((r[SESSIONS_KEY] as Record<string, BridgeSession> | undefined) ?? {}), ...sessionsCache };
  });
  await sessionsLoaded;
  return sessionsCache;
}

async function saveSessions(): Promise<void> {
  await chrome.storage.session.set({ [SESSIONS_KEY]: sessionsCache });
}

export function sessionSummaries(): { token: string; cwd: string; connected: boolean; waiting: boolean; shared: string[] }[] {
  return Object.values(sessionsCache).map((s) => {
    const l = live.get(s.token);
    return { token: s.token, cwd: s.cwd, connected: !!l?.connected, waiting: !!l?.connected && l.waiting, shared: s.shared };
  });
}

export function hasSession(token: string): boolean {
  return token in sessionsCache;
}

export function isConnected(token: string): boolean {
  return !!live.get(token)?.connected;
}

async function forget(token: string): Promise<void> {
  const l = live.get(token);
  if (l?.ping) clearInterval(l.ping);
  live.delete(token);
  delete sessionsCache[token];
  await saveSessions();
  controller.broadcastState();
}

function send(ws: WebSocket, msg: ExtensionMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleRequest(session: BridgeSession, method: MethodName, params: unknown): Promise<unknown> {
  const parsed = Methods[method].params.safeParse(params ?? {});
  if (!parsed.success) throw new BridgeError('bad-request', `Invalid parameters for ${method}: ${parsed.error.message}`);
  const requireShared = (id: string) => {
    if (!session.shared.includes(id)) throw new BridgeError('not-shared', `Recording ${id} is not shared with this session. Ask the user to share it from Chrome.`);
  };
  switch (method) {
    case 'listRecordings':
      return (await store.listRecordings()).filter((r) => session.shared.includes(r.id));
    case 'getRecording': {
      const { id } = parsed.data as { id: string };
      requireShared(id);
      const recording = await store.getRecording(id);
      if (!recording) throw new BridgeError('not-found', `Recording ${id} no longer exists (it may have been deleted).`);
      return { recording, images: await store.getImages(store.imageIds(recording)) };
    }
    case 'replay': {
      const p = parsed.data as { id: string };
      requireShared(p.id);
      return controller.replayRecording(params as Parameters<typeof controller.replayRecording>[0]);
    }
    case 'openTab': {
      const { url } = parsed.data as { url: string };
      if (!isWebUrl(url)) throw new BridgeError('bad-request', `Only http and https URLs can be opened, got ${url}`);
      await chrome.tabs.create({ url });
      return { ok: true };
    }
  }
}

function connect(session: BridgeSession): void {
  const existing = live.get(session.token);
  if (existing?.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) return;
  const state: Live = existing ?? { ws: null, connected: false, waiting: false, attempt: 0, closing: false };
  live.set(session.token, state);

  const ws = new WebSocket(`ws://127.0.0.1:${session.port}`);
  state.ws = ws;
  ws.onopen = () => send(ws, { type: 'hello', token: session.token, decision: 'approved', extensionVersion: STR_VERSION });
  ws.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = ServerMessageSchema.parse(JSON.parse(String(ev.data)));
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      state.connected = true;
      state.attempt = 0;
      if (state.ping) clearInterval(state.ping);
      // Messages on an open socket keep the MV3 service worker alive.
      state.ping = setInterval(() => send(ws, { type: 'ping' }), PING_MS);
      controller.broadcastState();
    } else if (msg.type === 'waiting') {
      state.waiting = msg.waiting;
      controller.broadcastState();
    } else if (msg.type === 'request') {
      const current = sessionsCache[session.token] ?? session;
      handleRequest(current, msg.method, msg.params).then(
        (result) => send(ws, { type: 'response', id: msg.id, result }),
        (e) => {
          const code: ErrorCode = e instanceof BridgeError ? e.code : 'internal';
          send(ws, { type: 'response', id: msg.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
        },
      );
    }
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    const wasConnected = state.connected;
    state.connected = false;
    state.waiting = false;
    state.ws = null;
    if (state.ping) clearInterval(state.ping);
    controller.broadcastState();
    // The server ended the session, or rejected us: forget it.
    if (ev.code === 4401 || ev.code === 4400 || (ev.code === 1000 && ev.reason === 'server closing')) {
      void forget(session.token);
      return;
    }
    if (ev.code === 1000 && ev.reason === 'replaced') return;
    // Otherwise retry; a server that stays unreachable has gone away.
    const delay = RETRY_DELAYS_MS[state.attempt];
    if (delay === undefined) {
      void forget(session.token);
      return;
    }
    if (!wasConnected) state.attempt++;
    else state.attempt = 0;
    setTimeout(() => {
      if (sessionsCache[session.token]) connect(sessionsCache[session.token]!);
    }, delay);
  };
}

/** Called by the consent page after the user approves. */
export async function approve(p: { port: number; token: string; cwd: string }): Promise<void> {
  await loadSessions();
  sessionsCache[p.token] = { port: p.port, token: p.token, cwd: p.cwd, shared: [], approvedAt: Date.now() };
  await saveSessions();
  connect(sessionsCache[p.token]!);
  controller.broadcastState();
}

/** Shares a recording with a connected session and tells its agent; called when the user clicks "Send to agent". */
export async function sendRecording(token: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await loadSessions();
  const session = sessionsCache[token];
  const ws = live.get(token)?.ws;
  if (!session || !ws || !isConnected(token)) return { ok: false, error: 'That agent is not connected any more. Run the skill again in your agent to reconnect.' };
  if (!(await store.getRecording(id))) return { ok: false, error: 'Recording not found' };
  if (!session.shared.includes(id)) session.shared.push(id);
  await saveSessions();
  send(ws, { type: 'recording-sent', id, title: (await store.listRecordings()).find((r) => r.id === id)?.title });
  controller.broadcastState();
  return { ok: true };
}

export interface FoundSession {
  port: number;
  token: string;
  cwd: string;
  startedAt: number;
  client?: 'terminal' | 'app';
}

const PROBE_TIMEOUT_MS = 1500;

/** Asks the MCP server on `port`, if any, which session it belongs to. */
function probe(port: number): Promise<FoundSession | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      resolve(null);
      return;
    }
    const done = (v: FoundSession | null) => {
      clearTimeout(timer);
      resolve(v);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    ws.onopen = () => send(ws, { type: 'discover' });
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        /* not ours */
      }
      const msg = ServerMessageSchema.safeParse(data);
      done(msg.success && msg.data.type === 'session-info' ? { port, token: msg.data.token, cwd: msg.data.cwd, startedAt: msg.data.startedAt, ...(msg.data.client ? { client: msg.data.client } : {}) } : null);
    };
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
  });
}

/** Running agent sessions on this machine that this browser is not connected to yet, newest first. */
export async function discoverSessions(): Promise<FoundSession[]> {
  await loadSessions();
  const ports = Array.from({ length: DISCOVERY_PORT_COUNT }, (_, i) => DISCOVERY_PORT_FIRST + i);
  const found = await Promise.all(ports.map(probe));
  // Newest session first; ties (sessions started in the same second) by folder, then port, so the order never shuffles.
  return found
    .filter((s): s is FoundSession => !!s && !isConnected(s.token))
    .sort((a, b) => b.startedAt - a.startedAt || a.cwd.localeCompare(b.cwd) || a.port - b.port);
}

/** Tells the waiting server that the user declined, then disconnects. */
export function deny(p: { port: number; token: string }): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}`);
    const done = () => resolve();
    ws.onopen = () => {
      send(ws, { type: 'hello', token: p.token, decision: 'denied', extensionVersion: STR_VERSION });
      setTimeout(() => ws.close(), 200);
    };
    ws.onclose = done;
    ws.onerror = done;
  });
}

/** Makes sure a known session is connected (used when the consent page is reopened for it). */
export async function ensureConnected(token: string): Promise<boolean> {
  await loadSessions();
  const s = sessionsCache[token];
  if (!s) return false;
  connect(s);
  return true;
}

/** Reconnects every stored session; runs on every service worker start. */
export async function restoreSessions(): Promise<void> {
  for (const s of Object.values(await loadSessions())) connect(s);
}
