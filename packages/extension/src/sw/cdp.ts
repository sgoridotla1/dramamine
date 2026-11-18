/** Thin wrapper around chrome.debugger for one tab. */

type EventHandler = (method: string, params: any) => void;
type DetachHandler = (reason: string) => void;

const PROTOCOL_VERSION = '1.3';

export { isRestrictedUrl } from './cdp-url';

const sessions = new Map<number, CdpSession>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined) sessions.get(source.tabId)?.dispatch(method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const s = sessions.get(source.tabId);
  if (!s) return;
  sessions.delete(source.tabId);
  s.detached(reason);
});

export class CdpSession {
  private handlers = new Set<EventHandler>();
  private detachHandlers = new Set<DetachHandler>();
  private users = 0;
  attached = false;

  private constructor(readonly tabId: number) {}

  /** Attaches (or reuses an existing attachment) for a tab. Each acquire must be paired with release. */
  static async acquire(tabId: number): Promise<CdpSession> {
    let s = sessions.get(tabId);
    if (!s) {
      s = new CdpSession(tabId);
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } catch (e) {
        throw new Error(attachErrorMessage(e));
      }
      s.attached = true;
      sessions.set(tabId, s);
    }
    s.users++;
    return s;
  }

  async release(): Promise<void> {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.attached) return;
    sessions.delete(this.tabId);
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  send<T = any>(method: string, params: { [key: string]: unknown } = {}): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as unknown as Promise<T>;
  }

  onEvent(h: EventHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onDetach(h: DetachHandler): () => void {
    this.detachHandlers.add(h);
    return () => this.detachHandlers.delete(h);
  }

  /** @internal */
  dispatch(method: string, params: any): void {
    for (const h of this.handlers) {
      try {
        h(method, params);
      } catch (e) {
        console.error('[str] cdp handler failed', method, e);
      }
    }
  }

  /** @internal */
  detached(reason: string): void {
    this.attached = false;
    this.users = 0;
    for (const h of this.detachHandlers) h(reason);
  }
}

function attachErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/another debugger/i.test(msg)) return `Could not attach to the tab: ${msg}. Close DevTools or other debugging tools on this tab and try again.`;
  return `Could not attach to the tab: ${msg}`;
}
