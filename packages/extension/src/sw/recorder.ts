import type { Recording } from '@str/shared';
import type { RawNetwork, RawStep } from '../messages';
import { CdpSession, isRestrictedUrl } from './cdp';
import { emptySession, finalize, type RawCheckpoint, type RawSession } from './finalize';
import { capBody, MASK, redactBodyText, redactNetwork } from './redact';

const STACK_FRAMES = 5;
const BODY_TIMEOUT_MS = 1000;

interface PendingRequest {
  /** The recorded entry, created when the request is sent and completed as events arrive. */
  entry: RawNetwork;
  startTs: number;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function formatFrames(frames: any[] | undefined): string[] | undefined {
  if (!frames?.length) return undefined;
  return frames.slice(0, STACK_FRAMES).map((f) => `${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`);
}

function formatArg(a: any): string {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.unserializableValue ?? a.description ?? `[${a.type}]`;
}

export class RecordingSession {
  readonly raw: RawSession;
  /** Checkpoint screenshots captured during the session, by blob id. */
  readonly images: Record<string, string> = {};
  paused = false;
  private pending = new Map<string, PendingRequest>();
  private unsubscribers: (() => void)[] = [];
  private stopped = false;

  private constructor(
    readonly tabId: number,
    readonly cdp: CdpSession,
    raw: RawSession,
    private readonly onInterrupted: (s: RecordingSession, reason: string) => void,
  ) {
    this.raw = raw;
  }

  static async start(tabId: number, onInterrupted: (s: RecordingSession, reason: string) => void): Promise<RecordingSession> {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) throw new Error(`Recording is not possible on this page (${tab.url ?? 'unknown URL'}). Browser and Web Store pages cannot be debugged.`);

    const cdp = await CdpSession.acquire(tabId);
    try {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent })',
        returnByValue: true,
      });
      const env = result.value as { w: number; h: number; dpr: number; ua: string };
      const raw = emptySession({
        id: newId('rec'),
        title: tab.title || new URL(tab.url!).host,
        startUrl: tab.url!,
        viewport: { width: env.w, height: env.h, deviceScaleFactor: env.dpr },
        browserVersion: env.ua.match(/Chrome\/[\d.]+/)?.[0] ?? env.ua,
        startedAt: Date.now(),
      });
      const session = new RecordingSession(tabId, cdp, raw, onInterrupted);
      session.subscribe();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable', { maxPostDataSize: 64 * 1024 });
      await cdp.send('Page.enable');
      return session;
    } catch (e) {
      await cdp.release();
      throw e;
    }
  }

  private subscribe(): void {
    this.unsubscribers.push(
      this.cdp.onEvent((method, params) => this.onCdpEvent(method, params)),
      this.cdp.onDetach((reason) => {
        this.onInterrupted(this, reason === 'canceled_by_user' ? 'Debugging was cancelled from the browser info bar' : `Debugger detached (${reason})`);
      }),
    );
    const onRemoved = (tabId: number) => {
      if (tabId === this.tabId) this.onInterrupted(this, 'The recorded tab was closed');
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    this.unsubscribers.push(() => chrome.tabs.onRemoved.removeListener(onRemoved));
  }

  addStep(step: RawStep): void {
    if (this.stopped || this.paused) return;
    if (step.kind === 'input' && step.redacted) {
      this.raw.redactions++;
      step = { ...step, value: MASK };
    }
    this.raw.steps.push(step);
  }

  addNote(text: string, at = Date.now()): void {
    if (this.stopped) return;
    this.raw.notes.push({ text, at });
  }

  addCheckpoint(cp: RawCheckpoint, images: Record<string, string>): void {
    this.raw.checkpoints.push(cp);
    Object.assign(this.images, images);
  }

  /** Number of user-visible steps so far (approximate: double-clicks are folded at the end). */
  get stepCount(): number {
    return this.raw.steps.length + this.raw.navigations.length;
  }

  private onCdpEvent(method: string, p: any): void {
    if (this.stopped) return;
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : null;
        if (!level) return;
        this.raw.console.push({ at: p.timestamp ?? Date.now(), level, text: (p.args ?? []).map(formatArg).join(' '), stack: formatFrames(p.stackTrace?.callFrames) });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const description: string = d.exception?.description ?? d.text ?? 'Uncaught exception';
        this.raw.console.push({
          at: p.timestamp ?? Date.now(),
          level: 'exception',
          text: description.split('\n')[0]!,
          stack: formatFrames(d.stackTrace?.callFrames) ?? description.split('\n').slice(1, 1 + STACK_FRAMES).map((l) => l.trim().replace(/^at /, '')),
        });
        return;
      }
      case 'Network.requestWillBeSent': {
        if (p.type !== 'Fetch' && p.type !== 'XHR') return;
        const { entry, count } = redactNetwork({
          at: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(),
          method: p.request.method,
          url: p.request.url,
          resourceType: p.type === 'Fetch' ? 'fetch' : 'xhr',
          requestHeaders: p.request.headers ?? {},
          requestText: p.request.postData,
          // Cleared when the request completes; stays if the page navigated away first.
          errorText: 'no response before the page moved on or the recording stopped',
        });
        this.raw.redactions += count;
        this.raw.network.push(entry);
        this.pending.set(p.requestId, { entry, startTs: p.timestamp });
        return;
      }
      case 'Network.responseReceived': {
        const r = this.pending.get(p.requestId);
        if (!r) return;
        r.entry.status = p.response.status;
        delete r.entry.errorText;
        r.entry.durationMs = Math.round((p.timestamp - r.startTs) * 1000);
        return;
      }
      case 'Network.loadingFinished': {
        const r = this.pending.get(p.requestId);
        if (!r) return;
        this.pending.delete(p.requestId);
        delete r.entry.errorText;
        r.entry.durationMs = Math.round((p.timestamp - r.startTs) * 1000);
        void this.fetchBody(p.requestId, r.entry);
        return;
      }
      case 'Network.loadingFailed': {
        const r = this.pending.get(p.requestId);
        if (!r) return;
        this.pending.delete(p.requestId);
        r.entry.errorText = p.errorText;
        r.entry.durationMs = Math.round((p.timestamp - r.startTs) * 1000);
        return;
      }
      case 'Page.frameNavigated': {
        if (p.frame.parentId) return;
        this.raw.navigations.push({ url: p.frame.url, at: Date.now() });
        return;
      }
      case 'Page.windowOpen': {
        this.addNote(`A new tab or popup was opened (${p.url}) and was not recorded`);
        return;
      }
      case 'Page.navigatedWithinDocument': {
        this.raw.navigations.push({ url: p.url, at: Date.now() });
        return;
      }
    }
  }

  private async fetchBody(requestId: string, entry: RawNetwork): Promise<void> {
    const body = await Promise.race([
      this.cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).catch(() => null),
      new Promise<null>((res) => setTimeout(() => res(null), BODY_TIMEOUT_MS)),
    ]);
    if (!body || body.base64Encoded || this.stopped) return;
    const { text, count } = redactBodyText(body.body);
    this.raw.redactions += count;
    entry.responseBody = capBody(text);
  }

  /** Stops capturing and assembles the recording. Safe to call more than once. */
  async stop(opts: { interrupted?: string } = {}): Promise<Recording | null> {
    if (this.stopped) return null;
    // Give in-flight body fetches a moment to complete.
    if (!opts.interrupted) await new Promise((r) => setTimeout(r, 200));
    this.stopped = true;
    for (const u of this.unsubscribers) u();
    this.raw.endedAt = Date.now();
    if (opts.interrupted) this.raw.interrupted = { reason: opts.interrupted };
    if (this.cdp.attached) {
      await this.cdp.send('Network.disable').catch(() => {});
      await this.cdp.send('Runtime.disable').catch(() => {});
    }
    await this.cdp.release();
    return finalize(this.raw);
  }
}
