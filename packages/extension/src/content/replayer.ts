import type { CheckpointCheck, CheckResult, ElementFacts, Locator, Match } from '@str/shared';
import { containsDeep, elementText, isVisible, normalizeText } from '../locators/dom';
import { describeElement } from '../locators/generate';
import { resolveAll, resolveTarget } from '../locators/resolve';

const POLL_MS = 100;
/** Checks must give the same results this long before a checkpoint settles, so "not contains" / "hidden" cannot pass before data renders. */
const STABLE_MS = 500;
const MAX_HTML = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResolveReply = { ok: true; match: Match; box: Box; center: { x: number; y: number }; isBody: boolean } | { ok: false; reason: string; tried: string[] };

/** The element at a point, descending into open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Why the element cannot be acted on right now, or null when it can. */
async function notActionable(el: Element): Promise<string | null> {
  if (!el.isConnected) return 'the element was removed from the page';
  if (!isVisible(el)) return 'the element is not visible';
  if (isDisabled(el)) return 'the element is disabled';
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  const b1 = boxOf(el);
  await frame();
  const b2 = boxOf(el);
  if (!sameBox(b1, b2)) return 'the element is still moving';
  const cx = b2.x + b2.width / 2;
  const cy = b2.y + b2.height / 2;
  const hit = deepElementFromPoint(cx, cy);
  if (!hit) return 'the element is outside the viewport';
  if (hit !== el && !containsDeep(el, hit)) return `another element would receive the input: ${describeElement(hit)}`;
  return null;
}

/** Waits until the target resolves (and, if asked, is actionable); returns where to send input. */
export async function resolveForAction(locators: Locator[], timeoutMs: number, actionable: boolean): Promise<ResolveReply> {
  const deadline = Date.now() + timeoutMs;
  let last: ResolveReply = { ok: false, reason: 'not resolved', tried: [] };
  for (;;) {
    const r = resolveTarget(locators);
    if (r.ok) {
      const isBody = r.element === document.body || r.element === document.documentElement;
      const why = actionable && !isBody ? await notActionable(r.element) : null;
      if (!why) {
        const box = boxOf(r.element);
        return { ok: true, match: r.match, box, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, isBody };
      }
      last = { ok: false, reason: why, tried: [] };
    } else {
      last = { ok: false, reason: r.reason, tried: r.tried };
    }
    if (Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

export async function focusTarget(locators: Locator[], timeoutMs: number): Promise<ResolveReply> {
  const r = await resolveForAction(locators, timeoutMs, false);
  if (r.ok) {
    const el = resolveTarget(locators);
    if (el.ok) (el.element as HTMLElement).focus?.();
  }
  return r;
}

export function selectState(locators: Locator[]): { value: string; label: string } | null {
  const r = resolveTarget(locators);
  if (!r.ok || !(r.element instanceof HTMLSelectElement)) return null;
  return { value: r.element.value, label: r.element.selectedOptions[0]?.textContent?.trim() ?? '' };
}

function factsOf(el: Element): ElementFacts {
  const html = el.outerHTML;
  return {
    text: elementText(el),
    visible: isVisible(el),
    html: html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}...` : html,
    ...(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? { value: el.value } : {}),
  };
}

export function evaluateCheck(check: CheckpointCheck, target: Element | null, targetLocators: Locator[]): CheckResult {
  const custom = check.target;
  const elements = custom ? resolveAll(custom) : target ? [target] : [];
  const el = elements[0] ?? null;
  const value = check.value === undefined ? '' : String(check.value);
  const text = el ? elementText(el) : '';
  const inputValue = el && 'value' in el ? String((el as HTMLInputElement).value) : '';
  // Absence answers exists/visible/hidden/count; for text and value checks it means the replay did not reach the state.
  const missing = (): CheckResult => ({ check, status: 'not-found', detail: 'the element was not found, so this check could not be evaluated' });
  switch (check.op) {
    case 'text-equals':
      if (!el) return missing();
      return { check, status: text === normalizeText(value) ? 'pass' : 'fail', actual: text };
    case 'text-contains':
      if (!el) return missing();
      return { check, status: text.includes(normalizeText(value)) ? 'pass' : 'fail', actual: text };
    case 'text-not-contains':
      if (!el) return missing();
      return { check, status: text.includes(normalizeText(value)) ? 'fail' : 'pass', actual: text };
    case 'exists':
      return { check, status: el ? 'pass' : 'fail', actual: el ? 'exists' : 'not found' };
    case 'visible':
      return { check, status: el && isVisible(el) ? 'pass' : 'fail', actual: !el ? 'not found' : isVisible(el) ? 'visible' : 'hidden' };
    case 'hidden':
      return { check, status: !el || !isVisible(el) ? 'pass' : 'fail', actual: !el ? 'not found' : isVisible(el) ? 'visible' : 'hidden' };
    case 'count': {
      const n = custom ? elements.length : targetLocators[0] ? resolveAll(targetLocators[0]).length : 0;
      return { check, status: n === Number(check.value) ? 'pass' : 'fail', actual: String(n) };
    }
    case 'value-equals':
      if (!el) return missing();
      return { check, status: inputValue === value ? 'pass' : 'fail', actual: inputValue };
    case 'value-contains':
      if (!el) return missing();
      return { check, status: inputValue.includes(value) ? 'pass' : 'fail', actual: inputValue };
    case 'judge':
      return { check, status: 'judged', ...(el ? { actual: text } : {}) };
  }
}

export interface CheckpointReply {
  found: boolean;
  match?: Match;
  facts?: ElementFacts;
  box?: Box;
  error?: string;
  results: CheckResult[];
}

/**
 * Finds the checkpoint target again and evaluates its checks, retrying until every
 * evaluable check passes or the timeout expires.
 */
export async function evaluateCheckpoint(locators: Locator[], checks: CheckpointCheck[], timeoutMs: number): Promise<CheckpointReply> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let since = Date.now();
  for (;;) {
    const r = resolveTarget(locators);
    const target = r.ok ? r.element : null;
    if (target && !isVisible(target)) target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    const results = checks.map((c) => evaluateCheck(c, target, locators));
    const now = Date.now();
    const key = JSON.stringify([!!target, results.map((x) => [x.status, x.actual])]);
    if (key !== last) (last = key), (since = now);
    const settled = results.every((x) => x.status === 'pass' || x.status === 'judged') && now - since >= STABLE_MS;
    const timedOut = now >= deadline;
    // With no checks, wait (up to the timeout) only for the target to appear.
    if ((checks.length ? settled : !!target) || timedOut) {
      return {
        found: !!target,
        ...(r.ok ? { match: r.match, facts: factsOf(r.element), box: boxOf(r.element) } : { error: r.reason }),
        results,
      };
    }
    await sleep(POLL_MS);
  }
}
