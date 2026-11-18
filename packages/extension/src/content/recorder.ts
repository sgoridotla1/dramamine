import type { RawStep } from '../messages';
import { parentElementDeep, roleOf } from '../locators/dom';
import { targetFor } from '../locators/generate';

const RECORDED_KEYS = new Set(['Enter', 'Escape', 'Tab']);
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color', 'hidden']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'treeitem', 'combobox']);
const ACTION_TARGET_DEPTH = 5;

export function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

function isInteractive(el: Element): boolean {
  if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) return true;
  if (el instanceof HTMLLabelElement || el.localName === 'summary' || el.localName === 'option') return true;
  const role = roleOf(el);
  return (!!role && INTERACTIVE_ROLES.has(role)) || el.hasAttribute('tabindex') || (el as HTMLElement).isContentEditable;
}

/** The element a click "means": the nearest interactive ancestor, e.g. the button around an icon. */
export function actionTarget(el: Element): Element {
  let cur: Element | null = el;
  for (let i = 0; cur && i < ACTION_TARGET_DEPTH; i++, cur = parentElementDeep(cur)) {
    if (isInteractive(cur)) return cur;
  }
  return el;
}

function deepTarget(e: Event): Element | null {
  const t = e.composedPath()[0];
  return t instanceof Element ? t : null;
}

export interface RecorderHooks {
  sendStep(step: RawStep): void;
  sendNote(text: string): void;
  /** True for elements that belong to the extension's own UI (checkpoint overlay). */
  isOwnUi(el: Element): boolean;
}

export class Recorder {
  paused = false;
  private readonly flushed = new WeakMap<Element, string>();
  private readonly dirty = new Set<Element>();
  private lastLabelClick: { control: Element; at: number } | null = null;
  private lastEnterAt = -Infinity;
  private dragNoted = false;
  private readonly listeners: [string, (e: any) => void][] = [
    ['click', (e: MouseEvent) => this.onClick(e)],
    ['dblclick', (e: MouseEvent) => this.onDblClick(e)],
    ['input', (e: Event) => this.onInput(e)],
    ['change', (e: Event) => this.onChange(e)],
    ['keydown', (e: KeyboardEvent) => this.onKeyDown(e)],
    ['dragstart', (e: DragEvent) => this.onDragStart(e)],
  ];

  constructor(private readonly hooks: RecorderHooks) {}

  start(): void {
    for (const [type, fn] of this.listeners) window.addEventListener(type, fn, true);
  }

  stop(): void {
    for (const [type, fn] of this.listeners) window.removeEventListener(type, fn, true);
    this.dirty.clear();
  }

  private accept(e: Event): Element | null {
    if (this.paused || !e.isTrusted) return null;
    const t = deepTarget(e);
    if (!t || this.hooks.isOwnUi(t)) return null;
    return t;
  }

  private step(step: RawStep): void {
    this.hooks.sendStep(step);
  }

  private onClick(e: MouseEvent): void {
    const t = this.accept(e);
    if (!t) return;
    if (t instanceof HTMLInputElement && t.type === 'file') {
      this.hooks.sendNote('A file upload field was clicked; file uploads are not recorded');
      return;
    }
    // Clicks that only focus a field or open a native select are covered by input/select steps.
    if (isTextField(t) || t instanceof HTMLSelectElement || t instanceof HTMLOptionElement) return;
    // Enter in a form (or on a focused button) dispatches a click with detail 0; the key step already reproduces it.
    if (e.detail === 0 && e.timeStamp - this.lastEnterAt < 100) return;
    // A click on a <label> also dispatches a click on its control; record only the label click.
    if (this.lastLabelClick && this.lastLabelClick.control === t && e.timeStamp - this.lastLabelClick.at < 100) {
      this.lastLabelClick = null;
      return;
    }
    const el = actionTarget(t);
    if (el instanceof HTMLLabelElement && el.control) this.lastLabelClick = { control: el.control, at: e.timeStamp };
    if (isTextField(el) || el instanceof HTMLSelectElement) return;
    this.step({ kind: 'click', at: Date.now(), target: targetFor(el) });
  }

  private onDblClick(e: MouseEvent): void {
    const t = this.accept(e);
    if (!t || isTextField(t)) return;
    this.step({ kind: 'dblclick', at: Date.now(), target: targetFor(actionTarget(t)) });
  }

  private onInput(e: Event): void {
    const t = this.accept(e);
    if (t && isTextField(t)) this.dirty.add(t);
  }

  private onChange(e: Event): void {
    const t = this.accept(e);
    if (!t) return;
    if (t instanceof HTMLSelectElement) {
      const option = t.selectedOptions[0];
      this.step({ kind: 'select', at: Date.now(), target: targetFor(t), value: t.value, label: option?.textContent?.trim() ?? t.value });
      return;
    }
    if (isTextField(t)) this.flushInput(t);
  }

  /** Records the field's final value once. */
  private flushInput(el: HTMLInputElement | HTMLTextAreaElement): void {
    const value = el.value;
    this.dirty.delete(el);
    if (this.flushed.get(el) === value) return;
    this.flushed.set(el, value);
    const redacted = el instanceof HTMLInputElement && el.type === 'password';
    // Password values never leave the page: the service worker only learns that one was typed.
    this.step({ kind: 'input', at: Date.now(), target: targetFor(el), value: redacted ? '' : value, ...(redacted ? { redacted: true } : {}) });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!RECORDED_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = this.accept(e);
    if (!t) return;
    if (e.key === 'Enter' && t instanceof HTMLTextAreaElement) return;
    // Commit a typed value before the key, so replay types first and presses the key second.
    if (isTextField(t) && (this.dirty.has(t) || (this.flushed.get(t) ?? '') !== t.value)) this.flushInput(t);
    if (e.key === 'Enter') this.lastEnterAt = e.timeStamp;
    this.step({ kind: 'key', at: Date.now(), key: e.key as 'Enter' | 'Escape' | 'Tab', target: targetFor(t) });
  }

  private onDragStart(e: DragEvent): void {
    if (!this.accept(e) || this.dragNoted) return;
    this.dragNoted = true;
    this.hooks.sendNote('Drag and drop was used; it is not recorded');
  }
}
