import { connectUrl, DISCOVERY_PORT_COUNT, DISCOVERY_PORT_FIRST, ExtensionMessageSchema, Methods, type ErrorCode, type MethodName, type MethodParams, type MethodResult, type ServerMessage } from '@str/shared';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export const CONSENT_TIMEOUT_MS = 120_000;
/** After a disconnect, how long to wait for the extension to reconnect by itself before reopening the consent page. */
export const RECONNECT_GRACE_MS = 3_000;

const REQUEST_TIMEOUT_MS: Record<MethodName, number> = {
  listRecordings: 30_000,
  getRecording: 30_000,
  replay: 10 * 60_000,
  openTab: 30_000,
};

export const INSTALL_HELP =
  'Make sure the Dramamine extension is installed and enabled in Chrome: in the Dramamine repository run `npm run build`, open chrome://extensions, turn on Developer mode, choose "Load unpacked" and select packages/extension/dist. Then try again.';

/** An error the agent should see verbatim. */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode | 'declined' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeOptions {
  cwd: string;
  extensionOrigin: string;
  /** Opens a URL in the user's Chrome; resolves false if it could not. */
  openUrl: (url: string) => Promise<boolean>;
  consentTimeoutMs?: number;
  reconnectGraceMs?: number;
  log?: (msg: string) => void;
  /** Ports to try before falling back to a random one (default: the discovery range). */
  ports?: number[];
}

const DISCOVERY_PORTS = Array.from({ length: DISCOVERY_PORT_COUNT }, (_, i) => DISCOVERY_PORT_FIRST + i);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Waiter = { resolve: () => void; reject: (e: Error) => void };

/**
 * The server side of the extension link: a WebSocket listener on the loopback interface,
 * started on first use, that accepts only the extension's origin presenting this session's token.
 */
export class Bridge {
  readonly token = randomBytes(32).toString('hex');
  readonly startedAt = Date.now();
  private wss: WebSocketServer | null = null;
  private port = 0;
  private socket: WebSocket | null = null;
  private everConnected = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private waiters: Waiter[] = [];
  private consentInFlight: Promise<void> | null = null;
  /** Recordings the user sent from the side panel that no wait has picked up yet. */
  private inbox: string[] = [];
  private readonly sent = new Set<string>();
  private inboxWaiters: (() => void)[] = [];
  /** Called when the user sends a recording while no wait_for_recording is pending, to wake the agent. */
  onUnclaimedRecording: ((r: { id: string; title?: string }) => void) | null = null;

  constructor(private readonly opts: BridgeOptions) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Ids of every recording the user sent to this session, oldest first. */
  get sentRecordings(): string[] {
    return [...this.sent];
  }

  /** The consent page URL for this session (the listener must be started). */
  consentUrl(appUrl?: string): string {
    return connectUrl(this.opts.extensionOrigin, { port: this.port, token: this.token, cwd: this.opts.cwd, ...(appUrl ? { appUrl } : {}) });
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /**
   * Starts the listener if needed and returns its port: the first free port of the discovery range,
   * so the side panel can find this session, or a random one if the range is taken.
   */
  async listen(): Promise<number> {
    if (this.wss) return this.port;
    let wss: WebSocketServer | null = null;
    for (const port of [...(this.opts.ports ?? DISCOVERY_PORTS), 0]) {
      wss = await this.tryListen(port);
      if (wss) break;
    }
    if (!wss) throw new BridgeError('unavailable', 'Could not listen on the loopback interface.');
    wss.on('connection', (ws) => this.onConnection(ws));
    this.wss = wss;
    this.port = (wss.address() as AddressInfo).port;
    this.log(`listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  private tryListen(port: number): Promise<WebSocketServer | null> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        maxPayload: 64 * 1024 * 1024,
        verifyClient: ({ origin }: { origin?: string }) => origin === this.opts.extensionOrigin,
      });
      wss.once('listening', () => resolve(wss));
      wss.once('error', () => resolve(null));
    });
  }

  private onConnection(ws: WebSocket): void {
    let authenticated = false;
    const helloTimer = setTimeout(() => !authenticated && ws.close(4401, 'hello expected'), 5000);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = ExtensionMessageSchema.parse(JSON.parse(String(data)));
      } catch {
        ws.close(4400, 'bad message');
        return;
      }
      if (!authenticated && msg.type === 'discover') {
        // The side panel lists running sessions; connecting is the user's click there.
        clearTimeout(helloTimer);
        ws.send(JSON.stringify({ type: 'session-info', token: this.token, cwd: this.opts.cwd, startedAt: this.startedAt, connected: this.connected } satisfies ServerMessage));
        ws.close(1000, 'discovered');
        return;
      }
      if (!authenticated) {
        if (msg.type !== 'hello' || msg.token !== this.token) {
          ws.close(4401, 'unauthorized');
          return;
        }
        clearTimeout(helloTimer);
        authenticated = true;
        if (msg.decision === 'denied') {
          ws.close(1000, 'declined');
          this.settleWaiters(new BridgeError('declined', 'The user declined the connection in Chrome. Ask them whether they want to share a recording, then try again.'));
          return;
        }
        // A newer connection for this session replaces an older one.
        if (this.socket && this.socket !== ws) this.socket.close(1000, 'replaced');
        this.socket = ws;
        this.everConnected = true;
        this.send({ type: 'welcome', cwd: this.opts.cwd });
        if (this.inboxWaiters.length) this.send({ type: 'waiting', waiting: true });
        this.log('extension connected');
        this.settleWaiters();
        return;
      }
      if (msg.type === 'ping') this.send({ type: 'pong' });
      else if (msg.type === 'response') this.onResponse(msg);
      else if (msg.type === 'recording-sent') this.onRecordingSent(msg.id, msg.title);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.socket !== ws) return;
      this.socket = null;
      this.log('extension disconnected');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BridgeError('unavailable', 'The extension disconnected while handling the request. Try again.'));
        this.pending.delete(id);
      }
    });
    ws.on('error', () => {});
  }

  private onResponse(msg: { id: number; result?: unknown; error?: { code: ErrorCode; message: string } }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }

  private onRecordingSent(id: string, title?: string): void {
    this.log(`recording ${id} sent`);
    this.sent.add(id);
    if (!this.inbox.includes(id)) this.inbox.push(id);
    if (!this.inboxWaiters.length) this.onUnclaimedRecording?.({ id, ...(title ? { title } : {}) });
    const ws = this.inboxWaiters;
    this.inboxWaiters = [];
    for (const w of ws) w();
  }

  /**
   * Resolves with the id of the next recording the user sends (or one they sent since the last
   * call), or null after `timeoutMs` or on abort. While it waits, the side panel shows that the agent is waiting.
   */
  async nextRecording(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const ready = this.inbox.shift();
    if (ready) return ready;
    const arrived = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.inboxWaiters = this.inboxWaiters.filter((w) => w !== onSent);
        if (!this.inboxWaiters.length) this.send({ type: 'waiting', waiting: false });
        resolve(v);
      };
      const onSent = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      signal?.addEventListener('abort', onAbort);
      this.inboxWaiters.push(onSent);
      this.send({ type: 'waiting', waiting: true });
    });
    return arrived ? (this.inbox.shift() ?? null) : null;
  }

  private send(msg: ServerMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private settleWaiters(err?: Error): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) (err ? w.reject(err) : w.resolve());
  }

  private waitForConnection(ms: number): Promise<boolean> {
    if (this.socket) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => (clearTimeout(timer), resolve(true)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /**
   * Ensures the extension is connected: waits for a reconnect, or opens the consent page and waits for approval.
   * `appUrl` is opened for the user once they approve. Resolves true if a new consent page was approved.
   */
  async ensureConnected(appUrl?: string): Promise<boolean> {
    if (this.socket) return false;
    await this.listen();
    if (this.everConnected && (await this.waitForConnection(this.opts.reconnectGraceMs ?? RECONNECT_GRACE_MS))) return false;
    this.consentInFlight ??= this.requestConsent(appUrl).finally(() => (this.consentInFlight = null));
    await this.consentInFlight;
    return true;
  }

  private async requestConsent(appUrl?: string): Promise<void> {
    const url = this.consentUrl(appUrl);
    const opened = await this.opts.openUrl(url);
    if (!opened) {
      this.log(`could not open ${url}`);
    }
    const timeout = this.opts.consentTimeoutMs ?? CONSENT_TIMEOUT_MS;
    const ok = await this.waitForConnection(timeout);
    if (!ok) {
      throw new BridgeError(
        'unavailable',
        `${opened ? `Chrome did not connect within ${Math.round(timeout / 1000)} seconds.` : 'Could not open Chrome automatically.'} ` +
          `${INSTALL_HELP} If Chrome is running with the extension, ask the user to open this URL in it and approve the connection: ${url}`,
      );
    }
  }

  async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    await this.ensureConnected();
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('unavailable', `The extension did not answer ${method} within ${REQUEST_TIMEOUT_MS[method] / 1000}s.`));
      }, REQUEST_TIMEOUT_MS[method]);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'request', id, method, params });
    });
    return Methods[method].result.parse(result) as MethodResult<M>;
  }

  async close(): Promise<void> {
    this.socket?.close(1000, 'server closing');
    this.socket = null;
    for (const w of this.inboxWaiters.splice(0)) w();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = null;
  }
}
