import type { ContentMode, ContentReadyReply, ContentToSw, SwToContent } from '../messages';
import { clearSnapshot, showOverlay, takeSnapshot } from './checkpoint';
import { Recorder } from './recorder';
import { evaluateCheckpoint, focusTarget, resolveForAction, selectState } from './replayer';

/** Host element of the extension's own UI injected into pages (checkpoint overlay). */
export const OWN_UI_ATTR = 'data-str-ui';

let mode: ContentMode = 'idle';
let recorder: Recorder | null = null;

function send(msg: ContentToSw): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function isOwnUi(el: Element): boolean {
  for (let cur: Node | null = el; cur; cur = cur.parentNode ?? (cur instanceof ShadowRoot ? cur.host : null)) {
    if (cur instanceof Element && cur.hasAttribute(OWN_UI_ATTR)) return true;
  }
  return false;
}

function setMode(next: ContentMode): void {
  if (next === mode) return;
  if (mode === 'record') {
    recorder?.stop();
    recorder = null;
    for (const el of Array.from(document.querySelectorAll(`[${OWN_UI_ATTR}]`))) el.remove();
  }
  mode = next;
  if (mode === 'record') {
    recorder = new Recorder({
      sendStep: (step) => void send({ type: 'step', step }),
      sendNote: (text) => void send({ type: 'note', text, at: Date.now() }),
      isOwnUi,
    });
    recorder.start();
  }
}

function reply<T>(p: Promise<T>, sendResponse: (r: unknown) => void): true {
  p.then(sendResponse, (e) => sendResponse({ ok: false, reason: e instanceof Error ? e.message : String(e), tried: [] }));
  return true;
}

function start(): void {
  chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
    // Replay commands are only served while the service worker drives this tab.
    if (mode !== 'replay' && (msg.type === 'resolve' || msg.type === 'focus' || msg.type === 'select-state' || msg.type === 'eval-checkpoint')) {
      sendResponse({ ok: false, reason: 'not in replay mode', tried: [] });
      return false;
    }
    switch (msg.type) {
      case 'resolve':
        return reply(resolveForAction(msg.locators, msg.timeoutMs, msg.actionable), sendResponse);
      case 'focus':
        return reply(focusTarget(msg.locators, msg.timeoutMs), sendResponse);
      case 'select-state':
        sendResponse(selectState(msg.locators));
        return false;
      case 'eval-checkpoint':
        return reply(evaluateCheckpoint(msg.locators, msg.checks, msg.timeoutMs), sendResponse);
      case 'set-mode':
        setMode(msg.mode);
        sendResponse({ ok: true });
        return false;
      case 'checkpoint-snapshot':
        if (recorder) recorder.paused = true;
        sendResponse({ count: takeSnapshot(isOwnUi), width: window.innerWidth });
        return false;
      case 'freeze':
        sendResponse({ ok: true });
        void showOverlay(msg.viewport, OWN_UI_ATTR).then(({ draft }) => {
          clearSnapshot();
          if (recorder) recorder.paused = false;
          void send({ type: 'checkpoint-done', ...(draft ? { draft } : {}) });
        });
        return false;
      default:
        return false;
    }
  });

  void (send({ type: 'content-ready' }) as Promise<ContentReadyReply | undefined>).then((reply) => {
    if (reply) setMode(reply.mode);
  });
}

// The service worker injects this script again into tabs that lost it (for example after the
// extension was reloaded). Run once per live extension context: an orphaned copy has no runtime id.
const marker = globalThis as { __strContentAlive?: () => boolean };
if (!marker.__strContentAlive?.()) {
  marker.__strContentAlive = () => !!chrome.runtime?.id;
  start();
}

export function contentRecorder(): Recorder | null {
  return recorder;
}
