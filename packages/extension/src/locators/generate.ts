import { DEFAULT_TESTID_ATTRIBUTES, type Locator, type Target } from '@str/shared';
import { accessibleName, elementText, isLabelable, labelTexts, normalizeText, parentElementDeep, roleOf } from './dom';
import { resolveAll } from './resolve';

export interface GenerateOptions {
  /** For checkpoint targets: never locate the element by its own text, which is expected to change. */
  excludeOwnText?: boolean;
  testIdAttributes?: readonly string[];
  /** Maximum number of candidates kept. */
  max?: number;
}

const MAX_TEXT = 80;
const MAX_SCOPE_DEPTH = 8;

/** Roles whose accessible name comes from their content. */
const NAME_FROM_CONTENT = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem', 'status', 'alert',
]);

function looksGenerated(s: string): boolean {
  // Hashed class names and ids such as "css-1x2y3z" or "a8f3e9b2c1".
  return /\d{3,}|[a-z0-9]{8,}-?[a-z0-9]*\d|^[a-z]{1,3}-[A-Za-z0-9_-]{5,}$/.test(s) || s.length > 40;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
}

/** True when the accessible name only repeats the element's own text. */
function nameIsOwnText(el: Element, name: string): boolean {
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title') || el.hasAttribute('alt')) return false;
  const role = roleOf(el);
  if (role && NAME_FROM_CONTENT.has(role)) return true;
  const own = elementText(el);
  return own.length > 0 && name.includes(own);
}

/** Candidates for the element itself, without uniqueness handling, in priority order. */
function rawCandidates(el: Element, opts: GenerateOptions): Locator[] {
  const out: Locator[] = [];
  for (const attr of opts.testIdAttributes ?? DEFAULT_TESTID_ATTRIBUTES) {
    const v = el.getAttribute(attr);
    if (v) out.push({ kind: 'testid', attr, value: v });
  }
  const role = roleOf(el);
  if (role && role !== 'generic' && role !== 'presentation' && role !== 'none') {
    const name = accessibleName(el);
    if (name && name.length <= MAX_TEXT && !(opts.excludeOwnText && nameIsOwnText(el, name))) {
      out.push({ kind: 'role', role, name });
    }
  }
  if (isLabelable(el)) {
    const label = labelTexts(el)[0];
    if (label && label.length <= MAX_TEXT) out.push({ kind: 'label', text: label });
  }
  const placeholder = normalizeText(el.getAttribute('placeholder'));
  if (placeholder) out.push({ kind: 'placeholder', text: placeholder });
  if (!opts.excludeOwnText) {
    const text = elementText(el);
    if (text && text.length <= MAX_TEXT) out.push({ kind: 'text', text });
  }
  return out;
}

/** A selector step for one element: tag, stable id or classes, plus :nth-of-type when needed among siblings. */
function cssStep(el: Element): string {
  const tag = el.localName;
  if (el.id && !looksGenerated(el.id)) return `#${cssEscape(el.id)}`;
  const classes = Array.from(el.classList).filter((c) => !looksGenerated(c)).slice(0, 2);
  let step = tag + classes.map((c) => `.${cssEscape(c)}`).join('');
  const parent = el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode : null);
  if (parent) {
    const sameTag = Array.from(parent.children).filter((s) => s.localName === tag);
    const sameStep = sameTag.filter((s) => s.matches(step));
    if (sameStep.length > 1) step = `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }
  return step;
}

/** A CSS path that is unique under the element's root (document or shadow root). */
function cssPath(el: Element): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const steps: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const step = cssStep(cur);
    steps.unshift(step);
    const selector = steps.join(' > ');
    if (step.startsWith('#') || cur.localName === 'body') break;
    if (el.isConnected) {
      try {
        if (root.querySelectorAll(selector).length === 1) break;
      } catch {
        /* keep walking */
      }
    }
  }
  return steps.join(' > ');
}

function isUnique(l: Locator, el: Element, root: Document): boolean {
  const found = resolveAll(l, root);
  return found.length === 1 && found[0] === el;
}

/** Locators an ancestor can be identified by, for scoping. Ancestors are always located without text. */
function ancestorCandidates(a: Element, opts: GenerateOptions): Locator[] {
  return rawCandidates(a, { ...opts, excludeOwnText: true }).filter((l) => l.kind !== 'text');
}

/** Makes a candidate unique: as is, scoped within a uniquely identifiable ancestor, or positional (fragile). */
function makeUnique(candidate: Locator, el: Element, root: Document, opts: GenerateOptions): Locator | null {
  const matches = resolveAll(candidate, root);
  if (!matches.includes(el)) return null;
  if (matches.length === 1) return candidate;

  let depth = 0;
  for (let a = parentElementDeep(el); a && a !== root.body && depth < MAX_SCOPE_DEPTH; a = parentElementDeep(a), depth++) {
    for (const scope of ancestorCandidates(a, opts)) {
      if (!isUnique(scope, a, root)) continue;
      const scoped: Locator = { ...candidate, within: scope };
      if (isUnique(scoped, el, root)) return scoped;
    }
  }
  return { ...candidate, nth: matches.indexOf(el), fragile: true };
}

function key(l: Locator): string {
  return JSON.stringify(l);
}

/** Generates unique locator candidates for an element, best first. */
export function generateLocators(el: Element, opts: GenerateOptions = {}): Locator[] {
  const max = opts.max ?? 5;
  if (!el.isConnected) return generateDetached(el, opts, max);

  const root = el.ownerDocument;
  const stable: Locator[] = [];
  const fragile: Locator[] = [];
  const seen = new Set<string>();
  const add = (l: Locator | null) => {
    if (!l || seen.has(key(l))) return;
    seen.add(key(l));
    (l.fragile ? fragile : stable).push(l);
  };

  for (const c of rawCandidates(el, opts)) add(makeUnique(c, el, root, opts));

  const css: Locator = { kind: 'css', selector: cssPath(el) };
  // A path inside a shadow root is only unique within that root, so scope it to the host.
  const rootNode = el.getRootNode();
  if (rootNode instanceof ShadowRoot) {
    const hostLocators = generateLocators(rootNode.host, { ...opts, excludeOwnText: true, max: 1 });
    if (hostLocators[0]) css.within = hostLocators[0];
  }
  add(makeUnique(css, el, root, opts));

  return [...stable, ...fragile].slice(0, max);
}

/** For elements removed from the page before locators were computed: uniqueness cannot be checked. */
function generateDetached(el: Element, opts: GenerateOptions, max: number): Locator[] {
  const out = rawCandidates(el, opts).map((l) => ({ ...l, unverified: true }) as Locator);
  out.push({ kind: 'css', selector: cssPath(el), unverified: true });
  return out.slice(0, max);
}

/** A short human description like "button 'Add to cart'" or "td". */
export function describeElement(el: Element, opts: { excludeOwnText?: boolean } = {}): string {
  const role = roleOf(el);
  const name = accessibleName(el);
  const label = role && role !== 'generic' ? role : el.localName;
  if (opts.excludeOwnText && name && nameIsOwnText(el, name)) return label;
  return name ? `${label} '${name.length > 40 ? `${name.slice(0, 37)}...` : name}'` : label;
}

export function targetFor(el: Element, opts: GenerateOptions = {}): Target {
  return { locators: generateLocators(el, opts), description: describeElement(el, opts) };
}
