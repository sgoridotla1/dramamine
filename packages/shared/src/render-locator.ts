import type { Locator } from './locator';

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function exactOpt(exact: boolean | undefined): string {
  return exact ? ', { exact: true }' : '';
}

function renderSelf(l: Locator): string {
  switch (l.kind) {
    case 'testid':
      return l.attr === 'data-testid' ? `getByTestId(${quote(l.value)})` : `locator(${quote(`[${l.attr}="${l.value}"]`)})`;
    case 'role': {
      const opts: string[] = [];
      if (l.name !== undefined) opts.push(`name: ${quote(l.name)}`);
      if (l.exact) opts.push('exact: true');
      return `getByRole(${quote(l.role)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
    }
    case 'label':
      return `getByLabel(${quote(l.text)}${exactOpt(l.exact)})`;
    case 'placeholder':
      return `getByPlaceholder(${quote(l.text)}${exactOpt(l.exact)})`;
    case 'text':
      return `getByText(${quote(l.text)}${exactOpt(l.exact)})`;
    case 'css':
      return `locator(${quote(l.selector)})`;
  }
}

/** Renders a locator as a Playwright locator chain, e.g. `getByTestId('card').getByRole('button', { name: 'Add' })`. */
export function renderLocator(l: Locator): string {
  const scope = l.within ? `${renderLocator(l.within)}.` : '';
  const nth = l.nth !== undefined ? `.nth(${l.nth})` : '';
  return `${scope}${renderSelf(l)}${nth}`;
}

/** Renders a locator with its quality markers appended, for logs and reports. */
export function renderLocatorWithMarkers(l: Locator): string {
  const markers: string[] = [];
  if (l.fragile) markers.push('fragile');
  if (l.unverified) markers.push('unverified');
  return markers.length ? `${renderLocator(l)}  [${markers.join(', ')}]` : renderLocator(l);
}
