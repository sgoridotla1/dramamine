import { computeAccessibleName, getRole } from 'dom-accessibility-api';

export type SearchRoot = Document | Element | ShadowRoot;

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);

/** Every element under `root` in document order, descending into open shadow roots. */
export function deepElements(root: SearchRoot): Element[] {
  const out: Element[] = [];
  const visit = (node: Element | Document | ShadowRoot) => {
    for (const child of Array.from(node.children)) {
      if (SKIPPED_TAGS.has(child.tagName)) continue;
      out.push(child);
      if (child.shadowRoot) visit(child.shadowRoot);
      visit(child);
    }
  };
  if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
  visit(root);
  return out;
}

/** CSS matches under `root`, including inside open shadow roots (CSS itself does not pierce them). */
export function deepQueryAll(root: SearchRoot, selector: string): Element[] {
  const roots: (SearchRoot)[] = [root];
  for (const el of deepElements(root)) if (el.shadowRoot) roots.push(el.shadowRoot);
  const seen = new Set<Element>();
  for (const r of roots) for (const el of Array.from(r.querySelectorAll(selector))) seen.add(el);
  // Keep document order.
  return deepElements(root).filter((el) => seen.has(el));
}

/** The parent element, crossing shadow boundaries to the host. */
export function parentElementDeep(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function containsDeep(ancestor: Element, el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = parentElementDeep(cur)) if (cur === ancestor) return true;
  return false;
}

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Text content with whitespace normalised, descending into open shadow roots. */
export function elementText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return '';
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (node instanceof Element) {
      if (SKIPPED_TAGS.has(node.tagName)) return;
      if (node.shadowRoot) visit(node.shadowRoot);
      for (const c of Array.from(node.childNodes)) visit(c);
    } else if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
      for (const c of Array.from(node.childNodes)) visit(c);
    }
  };
  visit(el);
  return normalizeText(parts.join(' '));
}

export function textMatches(actual: string, expected: string, exact: boolean | undefined): boolean {
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  return exact ? a === e : a.toLowerCase().includes(e.toLowerCase());
}

export function roleOf(el: Element): string | null {
  try {
    return getRole(el);
  } catch {
    return null;
  }
}

export function accessibleName(el: Element): string {
  try {
    return normalizeText(computeAccessibleName(el));
  } catch {
    return '';
  }
}

/** Visible in the sense of Playwright: has a box and is not visibility:hidden. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
  } else {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  }
  const rect = el.getBoundingClientRect();
  // happy-dom reports zero-size boxes for everything; treat "no layout" as visible there.
  if (rect.width === 0 && rect.height === 0) return !hasLayoutEngine(el);
  return true;
}

function hasLayoutEngine(el: Element): boolean {
  const body = el.ownerDocument.body;
  return !!body && body.getBoundingClientRect().height > 0;
}

/** Labels of a form control: <label> elements, aria-labelledby, aria-label. */
export function labelTexts(el: Element): string[] {
  const out: string[] = [];
  const labels = (el as HTMLInputElement).labels;
  if (labels) {
    for (const label of Array.from(labels)) {
      // Label text without the nested control's own text (e.g. <select> options).
      const clone = label.cloneNode(true) as Element;
      for (const c of Array.from(clone.querySelectorAll('input, select, textarea, button'))) c.remove();
      const t = normalizeText(clone.textContent);
      if (t) out.push(t);
    }
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = el.getRootNode() as Document | ShadowRoot;
    const t = normalizeText(
      labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById?.(id)?.textContent ?? '')
        .join(' '),
    );
    if (t) out.push(t);
  }
  const ariaLabel = normalizeText(el.getAttribute('aria-label'));
  if (ariaLabel) out.push(ariaLabel);
  return out;
}

export function isLabelable(el: Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el.hasAttribute('aria-labelledby') || el.hasAttribute('aria-label');
}
