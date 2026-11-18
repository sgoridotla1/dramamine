import { renderLocator, type Locator, type Match } from '@str/shared';
import {
  accessibleName,
  containsDeep,
  deepElements,
  deepQueryAll,
  elementText,
  isLabelable,
  isVisible,
  labelTexts,
  roleOf,
  textMatches,
  type SearchRoot,
} from './dom';

function matchesSelf(el: Element, l: Locator): boolean {
  switch (l.kind) {
    case 'testid':
      return el.getAttribute(l.attr) === l.value;
    case 'role':
      if (roleOf(el) !== l.role || !isVisible(el)) return false;
      return l.name === undefined || textMatches(accessibleName(el), l.name, l.exact);
    case 'label':
      return isLabelable(el) && labelTexts(el).some((t) => textMatches(t, l.text, l.exact));
    case 'placeholder': {
      const p = el.getAttribute('placeholder');
      return p !== null && textMatches(p, l.text, l.exact);
    }
    case 'text':
      return textMatches(elementText(el), l.text, l.exact);
    case 'css':
      return false; // handled by querySelectorAll
  }
}

function queryWithin(scope: SearchRoot, l: Locator): Element[] {
  if (l.kind === 'css') {
    try {
      return deepQueryAll(scope, l.selector);
    } catch {
      return [];
    }
  }
  const matches = deepElements(scope).filter((el) => matchesSelf(el, l));
  if (l.kind !== 'text') return matches;
  // Like Playwright's getByText: keep the innermost elements containing the text.
  return matches.filter((el) => !matches.some((other) => other !== el && containsDeep(el, other)));
}

/** All elements matched by a locator, in document order. */
export function resolveAll(l: Locator, root: SearchRoot = document): Element[] {
  let scopes: SearchRoot[] = [root];
  if (l.within) scopes = resolveAll(l.within, root);
  const seen = new Set<Element>();
  const out: Element[] = [];
  for (const scope of scopes) {
    for (const el of queryWithin(scope, l)) {
      if (el === scope || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  if (l.nth !== undefined) {
    const picked = out[l.nth];
    return picked ? [picked] : [];
  }
  return out;
}

export type ResolveResult = { ok: true; element: Element; match: Match } | { ok: false; reason: string; tried: string[] };

/** Tries candidates in stored order and uses the first that matches exactly one element. */
export function resolveTarget(locators: Locator[], root: SearchRoot = document): ResolveResult {
  const reasons: string[] = [];
  for (const [i, locator] of locators.entries()) {
    const found = resolveAll(locator, root);
    if (found.length === 1) return { ok: true, element: found[0]!, match: { candidate: i, locator, fallback: i > 0 } };
    reasons.push(`${renderLocator(locator)} matched ${found.length === 0 ? 'no elements' : `${found.length} elements`}`);
  }
  return { ok: false, reason: reasons.join('; '), tried: locators.map(renderLocator) };
}
