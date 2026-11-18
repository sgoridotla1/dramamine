import type { ElementFacts } from '@str/shared';
import type { CheckpointDraft } from '../messages';
import { deepElements, elementText, isVisible } from '../locators/dom';
import { describeElement, targetFor } from '../locators/generate';

/** Elements captured at freeze time: what was on screen when the user pressed the shortcut. */
interface SnapshotEntry {
  el: Element;
  rect: DOMRect;
  text: string;
  value?: string;
}

const MAX_TEXT = 300;
const MAX_HTML = 500;
const MIN_DRAG = 4;

let snapshot: SnapshotEntry[] = [];

/** Records every visible element in the viewport with its box and text. */
export function takeSnapshot(isOwnUi: (el: Element) => boolean): number {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  snapshot = [];
  for (const el of deepElements(document)) {
    if (isOwnUi(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) continue;
    if (!isVisible(el)) continue;
    snapshot.push({
      el,
      rect,
      text: elementText(el).slice(0, MAX_TEXT),
      ...(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? { value: el.value } : {}),
    });
  }
  return snapshot.length;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function contains(r: DOMRect, b: Box): boolean {
  return r.left <= b.x && r.top <= b.y && r.right >= b.x + b.width && r.bottom >= b.y + b.height;
}

/** The smallest snapshot element whose box fully contains the selection. */
export function snapTarget(b: Box): SnapshotEntry | null {
  let best: SnapshotEntry | null = null;
  for (const s of snapshot) {
    if (s.el === document.documentElement || s.el === document.body) continue;
    if (!contains(s.rect, b)) continue;
    if (!best || s.rect.width * s.rect.height <= best.rect.width * best.rect.height) best = s;
  }
  return best;
}

function factsFor(s: SnapshotEntry): ElementFacts {
  const html = s.el.outerHTML;
  return {
    text: s.text,
    visible: true,
    html: html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}...` : html,
    ...(s.value !== undefined ? { value: s.value } : {}),
  };
}

const STYLE = `
  :host { all: initial; }
  .root {
    --surface: #ffffff; --inset: #f4f4f5; --border: #e8e8ec; --border-strong: #d9d9e0;
    --text: #18181b; --text-2: #52525b; --text-3: #8b8b94;
    --brand: #6e56cf; --brand-hover: #5f48c0; --brand-soft: rgba(110, 86, 207, .14); --ring: rgba(110, 86, 207, .28);
    --bad-bg: #fff5f5; --bad-line: #fbd0d1; --bad-ink: #ce2c31;
    position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; color: var(--text);
    font: 13px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    .root {
      --surface: #18181b; --inset: #0f0f11; --border: #27272c; --border-strong: #35353c;
      --text: #ededef; --text-2: #b4b4bb; --text-3: #7c7c86;
      --brand: #7c66dc; --brand-hover: #8b77e3; --brand-soft: rgba(124, 102, 220, .2); --ring: rgba(124, 102, 220, .4);
      --bad-bg: #241315; --bad-line: #5a2427; --bad-ink: #ff9592;
    }
  }
  * { box-sizing: border-box; }
  .frozen { position: absolute; inset: 0; width: 100%; height: 100%; user-select: none; -webkit-user-drag: none; }
  .dim { position: absolute; inset: 0; background: rgba(12, 12, 16, .32); }
  .hint {
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
    padding: 7px 8px 7px 12px; border-radius: 999px; background: rgba(24, 24, 27, .92); color: #fff; font-weight: 500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .25); backdrop-filter: blur(8px); pointer-events: none; white-space: nowrap;
  }
  .hint svg { width: 15px; height: 15px; color: #b8a8ff; }
  .hint kbd { color: rgba(255, 255, 255, .8); background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .18); }
  .snap { position: absolute; border: 2px solid var(--brand); border-radius: 4px; background: var(--brand-soft); box-shadow: 0 0 0 4px var(--brand-soft), 0 0 0 9999px rgba(12, 12, 16, .18); pointer-events: none; display: none; transition: all .08s ease-out; }
  .sel { position: absolute; border: 1.5px dashed var(--brand); border-radius: 3px; background: rgba(255, 255, 255, .08); pointer-events: none; display: none; }
  .panel {
    position: absolute; width: 340px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, .06), 0 16px 40px rgba(0, 0, 0, .22); cursor: default; display: none; overflow: hidden;
    animation: rise .14s ease-out;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 0; }
  .head h3 { margin: 0; font-size: 13.5px; font-weight: 600; letter-spacing: -.01em; }
  .head svg { width: 16px; height: 16px; color: var(--brand); flex: none; }
  .target { margin-left: auto; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-2); background: var(--inset); border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; }
  .body { padding: 10px 14px 12px; }
  label { display: flex; align-items: baseline; gap: 6px; margin: 10px 0 5px; font-weight: 600; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); }
  label:first-child { margin-top: 2px; }
  label span { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .actual { background: var(--bad-bg); border: 1px solid var(--bad-line); color: var(--bad-ink); font-weight: 500; border-radius: 7px; padding: 7px 10px; max-height: 84px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  textarea { width: 100%; min-height: 64px; font: inherit; color: var(--text); background: var(--surface); padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: 7px; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--ring); }
  textarea::placeholder { color: var(--text-3); }
  .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--inset); }
  .keys { display: flex; align-items: center; gap: 4px; margin-top: 7px; color: var(--text-3); font-size: 11.5px; }
  .keys .sep { width: 6px; }
  kbd { display: inline-block; min-width: 18px; padding: 0 4px; font: 500 10.5px/16px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; color: var(--text-2); background: var(--surface); border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; }
  button { font: inherit; font-weight: 500; height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); cursor: pointer; }
  button:hover { filter: brightness(.97); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
  button.primary { background: var(--brand); border-color: transparent; color: #fff; }
  button.primary:hover { background: var(--brand-hover); filter: none; }
`;

const TARGET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';

export interface OverlayResult {
  draft?: CheckpointDraft;
}

/**
 * Shows the frozen screenshot over the page, lets the user drag a region that snaps to an
 * element, and collects the expected result. Resolves when the user saves or cancels.
 */
export function showOverlay(screenshotDataUrl: string, ownUiAttr: string): Promise<OverlayResult> {
  return new Promise((resolve) => {
    const host = document.createElement('str-checkpoint');
    host.setAttribute(ownUiAttr, '');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="root">
        <img class="frozen" alt="" draggable="false">
        <div class="dim"></div>
        <div class="hint">${TARGET_ICON}<span class="hint-text">Drag around the part that is wrong</span><kbd>Esc</kbd></div>
        <div class="snap"></div>
        <div class="sel"></div>
        <div class="panel" role="dialog" aria-label="Checkpoint">
          <div class="head">${TARGET_ICON}<h3>Mark what's wrong</h3><span class="target"></span></div>
          <div class="body">
            <label>Actual</label>
            <div class="actual"></div>
            <label for="expected">Expected <span>optional</span></label>
            <textarea id="expected" placeholder="What should it show? Leave empty to keep this as context only."></textarea>
            <div class="keys"><kbd>↵</kbd> save <span class="sep"></span> <kbd>⇧</kbd><kbd>↵</kbd> new line <span class="sep"></span> <kbd>Esc</kbd> cancel</div>
          </div>
          <div class="foot">
            <button class="cancel" type="button">Cancel</button><button class="primary save" type="button">Save checkpoint</button>
          </div>
        </div>
      </div>`;
    const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
    const img = $<HTMLImageElement>('.frozen');
    const snapBox = $<HTMLDivElement>('.snap');
    const selBox = $<HTMLDivElement>('.sel');
    const panel = $<HTMLDivElement>('.panel');
    const hint = $<HTMLDivElement>('.hint');
    const expected = $<HTMLTextAreaElement>('textarea');
    img.src = screenshotDataUrl;

    let start: { x: number; y: number } | null = null;
    let region: Box | null = null;
    let target: SnapshotEntry | null = null;

    const place = (div: HTMLElement, b: Box) => {
      Object.assign(div.style, { display: 'block', left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` });
    };

    const select = (b: Box) => {
      target = snapTarget(b);
      if (target) {
        place(snapBox, { x: target.rect.left, y: target.rect.top, width: target.rect.width, height: target.rect.height });
        host.dataset.snapped = describeElement(target.el);
      } else {
        snapBox.style.display = 'none';
        delete host.dataset.snapped;
      }
    };

    const finish = (result: OverlayResult) => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(result);
    };

    const save = () => {
      if (!target || !region) return;
      const draft: CheckpointDraft = {
        target: targetFor(target.el, { excludeOwnText: true }),
        actual: factsFor(target),
        region,
        ...(expected.value.trim() ? { expected: expected.value.trim() } : {}),
      };
      finish({ draft });
    };

    const openPanel = () => {
      if (!target) return;
      hint.querySelector('.hint-text')!.textContent = 'Describe the expected result, then save';
      const what = describeElement(target.el, { excludeOwnText: true });
      Object.assign($<HTMLSpanElement>('.target'), { textContent: what, title: what });
      $<HTMLDivElement>('.actual').textContent = target.text || '(no text)';
      const left = Math.min(Math.max(8, target.rect.left), window.innerWidth - 356);
      const below = target.rect.bottom + 8;
      const top = below + 290 < window.innerHeight ? below : Math.max(8, target.rect.top - 298);
      Object.assign(panel.style, { display: 'block', left: `${left}px`, top: `${top}px` });
      host.dataset.panel = 'open';
      expected.focus();
    };

    const root = $<HTMLDivElement>('.root');
    root.addEventListener('mousedown', (e) => {
      if (panel.contains(e.target as Node)) return;
      e.preventDefault();
      panel.style.display = 'none';
      delete host.dataset.panel;
      start = { x: e.clientX, y: e.clientY };
      region = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
      select(region);
    });
    root.addEventListener('mousemove', (e) => {
      if (!start) return;
      region = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      place(selBox, region);
      select(region);
    });
    root.addEventListener('mouseup', () => {
      if (!start || !region) return;
      start = null;
      selBox.style.display = 'none';
      // A click without a drag selects the element under the pointer.
      if (region.width < MIN_DRAG && region.height < MIN_DRAG) region = { x: region.x, y: region.y, width: 1, height: 1 };
      select(region);
      if (target) {
        // Use the element's box as the screenshot region so the crop shows all of it.
        region = { x: target.rect.left, y: target.rect.top, width: target.rect.width, height: target.rect.height };
        openPanel();
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish({});
      } else if (e.key === 'Enter' && !e.shiftKey && host.dataset.panel === 'open') {
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    $<HTMLButtonElement>('.save').addEventListener('click', save);
    $<HTMLButtonElement>('.cancel').addEventListener('click', () => finish({}));

    (document.body ?? document.documentElement).append(host);
  });
}

export function clearSnapshot(): void {
  snapshot = [];
}
