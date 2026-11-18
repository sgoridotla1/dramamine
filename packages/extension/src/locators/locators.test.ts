// @vitest-environment happy-dom
import { renderLocator, type Locator } from '@str/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateLocators, targetFor } from './generate';
import { resolveAll, resolveTarget } from './resolve';

function html(markup: string) {
  document.body.innerHTML = markup;
}

function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

beforeEach(() => html(''));

describe('candidate generation (element-locators: priority order)', () => {
  it('lists the test id first and role + name second', () => {
    html('<button data-testid="add-to-cart">Add to cart</button>');
    const [first, second] = generateLocators($('button'));
    expect(first).toEqual({ kind: 'testid', attr: 'data-testid', value: 'add-to-cart' });
    expect(second).toEqual({ kind: 'role', role: 'button', name: 'Add to cart' });
  });

  it('uses label and placeholder for form fields', () => {
    html('<label>Username <input name="u" placeholder="you@example.com"></label>');
    const rendered = generateLocators($('input')).map(renderLocator);
    expect(rendered).toContain("getByLabel('Username')");
    expect(rendered).toContain("getByPlaceholder('you@example.com')");
  });

  it('recognises the default test-id attributes, including data-hook', () => {
    html('<div data-hook="save-bar">x</div>');
    expect(generateLocators($('div'))[0]).toEqual({ kind: 'testid', attr: 'data-hook', value: 'save-bar' });
  });

  it('always includes a CSS fallback', () => {
    html('<main><section><p>hello</p></section></main>');
    expect(generateLocators($('p')).some((l) => l.kind === 'css')).toBe(true);
  });

  it('describes the target', () => {
    html('<button>Add to cart</button>');
    expect(targetFor($('button')).description).toBe("button 'Add to cart'");
  });
});

describe('uniqueness (element-locators: unique at record time)', () => {
  const cards = Array.from({ length: 12 }, (_, i) => `<div data-testid="product-card-${i + 1}"><h3>Item ${i + 1}</h3><button>Add to cart</button></div>`).join('');

  it('scopes a repeated button within its uniquely identifiable card', () => {
    html(cards);
    const button = $('[data-testid="product-card-7"] button');
    const role = generateLocators(button).find((l) => l.kind === 'role');
    expect(role).toBeDefined();
    expect(renderLocator(role!)).toBe("getByTestId('product-card-7').getByRole('button', { name: 'Add to cart' })");
    expect(resolveAll(role!)).toEqual([button]);
  });

  it('every generated locator matches exactly that element', () => {
    html(cards);
    const button = $('[data-testid="product-card-3"] button');
    for (const l of generateLocators(button)) expect(resolveAll(l)).toEqual([button]);
  });

  it('marks a positional locator as fragile when nothing else is unique', () => {
    html('<ul><li>a</li><li>a</li><li>a</li></ul>');
    const third = document.querySelectorAll('li')[2]!;
    const locators = generateLocators(third);
    const text = locators.find((l) => l.kind === 'text');
    expect(text).toMatchObject({ kind: 'text', text: 'a', nth: 2, fragile: true });
    // Non-fragile candidates come first.
    expect(locators[0]!.fragile).toBeFalsy();
    for (const l of locators) expect(resolveAll(l)).toEqual([third]);
  });
});

describe('checkpoint targets (element-locators: not located by own text)', () => {
  const cart = (total: string) => `
    <table><tbody><tr><td>Mug</td><td>2</td></tr></tbody>
    <tfoot><tr><th>Total</th><td></td><td data-testid="cart-total">${total}</td></tr></tfoot></table>`;

  it('never uses the target text and still resolves after the text changes', () => {
    html(cart('$0'));
    const locators = generateLocators($('[data-testid="cart-total"]'), { excludeOwnText: true });
    for (const l of locators) expect(JSON.stringify(l)).not.toContain('$0');

    html(cart('$42'));
    for (const l of locators) {
      const found = resolveAll(l);
      expect(found).toHaveLength(1);
      expect(found[0]!.textContent).toBe('$42');
    }
  });

  it('falls back to structure when there is no test id', () => {
    html(cart('$0').replace(' data-testid="cart-total"', ''));
    const target = $('tfoot td:last-child');
    const locators = generateLocators(target, { excludeOwnText: true });
    expect(locators.length).toBeGreaterThan(0);
    for (const l of locators) expect(JSON.stringify(l)).not.toContain('$0');
    html(cart('$42').replace(' data-testid="cart-total"', ''));
    expect(resolveTarget(locators)).toMatchObject({ ok: true });
  });

  it('keeps names that do not come from the element text', () => {
    html('<span role="status" aria-label="Cart total">$0</span>');
    const locators = generateLocators($('span'), { excludeOwnText: true });
    expect(locators[0]).toEqual({ kind: 'role', role: 'status', name: 'Cart total' });
  });
});

describe('resolution (element-locators: resolution during replay)', () => {
  it('uses a later candidate when the primary matches nothing, and reports it', () => {
    html('<button data-testid="checkout-btn">Checkout</button>');
    const locators: Locator[] = [
      { kind: 'testid', attr: 'data-testid', value: 'checkout-button' },
      { kind: 'role', role: 'button', name: 'Checkout' },
    ];
    const r = resolveTarget(locators);
    expect(r).toMatchObject({ ok: true, match: { candidate: 1, fallback: true } });
  });

  it('reports zero versus several matches when nothing resolves', () => {
    html('<button>Go</button><button>Go</button>');
    const r = resolveTarget([
      { kind: 'testid', attr: 'data-testid', value: 'nope' },
      { kind: 'role', role: 'button', name: 'Go' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("getByTestId('nope') matched no elements");
      expect(r.reason).toContain("getByRole('button', { name: 'Go' }) matched 2 elements");
      expect(r.tried).toHaveLength(2);
    }
  });

  it('pierces open shadow roots', () => {
    html('<counter-widget></counter-widget>');
    const host = $('counter-widget');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Increment</button><span data-testid="count">0</span>';
    const button = root.querySelector('button')!;

    expect(resolveAll({ kind: 'role', role: 'button', name: 'Increment' })).toEqual([button]);
    expect(resolveAll({ kind: 'testid', attr: 'data-testid', value: 'count' })).toEqual([root.querySelector('span')]);
    for (const l of generateLocators(button)) expect(resolveAll(l)).toEqual([button]);
  });

  it('matches text on the innermost element', () => {
    html('<div><p>Hello <b>world</b></p></div>');
    expect(resolveAll({ kind: 'text', text: 'world' })).toEqual([$('b')]);
    expect(resolveAll({ kind: 'text', text: 'Hello world', exact: true })).toEqual([$('p')]);
  });
});

describe('detached nodes', () => {
  it('computes unverified locators for an element that left the DOM', () => {
    html('<div class="toast" role="alert" aria-label="Notification">Saved with errors</div>');
    const toast = $('.toast');
    toast.remove();
    const locators = generateLocators(toast, { excludeOwnText: true });
    expect(locators.length).toBeGreaterThan(0);
    for (const l of locators) expect(l.unverified).toBe(true);
    expect(locators.map(renderLocator)).toContain("getByRole('alert', { name: 'Notification' })");
    expect(locators.some((l) => l.kind === 'css' && l.selector === 'div.toast')).toBe(true);
  });
});
