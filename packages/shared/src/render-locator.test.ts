import { describe, expect, it } from 'vitest';
import { renderLocator, renderLocatorWithMarkers } from './render-locator';

describe('renderLocator', () => {
  it('renders data-testid with getByTestId', () => {
    expect(renderLocator({ kind: 'testid', attr: 'data-testid', value: 'cart-total' })).toBe("getByTestId('cart-total')");
  });

  it('renders other test-id attributes as an attribute selector', () => {
    expect(renderLocator({ kind: 'testid', attr: 'data-hook', value: 'save' })).toBe(`locator('[data-hook="save"]')`);
  });

  it('renders role with and without name and exact', () => {
    expect(renderLocator({ kind: 'role', role: 'button', name: 'Save' })).toBe("getByRole('button', { name: 'Save' })");
    expect(renderLocator({ kind: 'role', role: 'button', name: 'Save', exact: true })).toBe("getByRole('button', { name: 'Save', exact: true })");
    expect(renderLocator({ kind: 'role', role: 'main' })).toBe("getByRole('main')");
  });

  it('renders label, placeholder, text and css', () => {
    expect(renderLocator({ kind: 'label', text: 'Username' })).toBe("getByLabel('Username')");
    expect(renderLocator({ kind: 'placeholder', text: 'Search' })).toBe("getByPlaceholder('Search')");
    expect(renderLocator({ kind: 'text', text: 'Total', exact: true })).toBe("getByText('Total', { exact: true })");
    expect(renderLocator({ kind: 'css', selector: 'tfoot > tr > td:nth-child(3)' })).toBe("locator('tfoot > tr > td:nth-child(3)')");
  });

  it('escapes quotes', () => {
    expect(renderLocator({ kind: 'text', text: "Don't" })).toBe("getByText('Don\\'t')");
  });

  it('renders scope as a chain', () => {
    expect(
      renderLocator({ kind: 'role', role: 'button', name: 'Add to cart', within: { kind: 'testid', attr: 'data-testid', value: 'product-card-17' } }),
    ).toBe("getByTestId('product-card-17').getByRole('button', { name: 'Add to cart' })");
  });

  it('renders nth after the locator', () => {
    expect(renderLocator({ kind: 'css', selector: 'li', nth: 2 })).toBe("locator('li').nth(2)");
  });

  it('appends fragile and unverified markers', () => {
    expect(renderLocatorWithMarkers({ kind: 'css', selector: 'li', nth: 2, fragile: true })).toBe("locator('li').nth(2)  [fragile]");
    expect(renderLocatorWithMarkers({ kind: 'text', text: 'Saved', unverified: true })).toBe("getByText('Saved')  [unverified]");
    expect(renderLocatorWithMarkers({ kind: 'text', text: 'Saved' })).toBe("getByText('Saved')");
  });
});
