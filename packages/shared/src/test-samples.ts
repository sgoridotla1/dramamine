import type { Recording } from './recording';

/** A small but complete recording: add two mugs to the cart, open the cart, checkpoint on the total. */
export function sampleRecording(): Recording {
  return {
    schemaVersion: 1,
    id: 'rec_1',
    title: 'Cart total shows $0',
    startUrl: 'http://localhost:3000/products.html',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    browserVersion: 'Chrome/153.0.0.0',
    startedAt: 1_000,
    endedAt: 9_000,
    steps: [
      { index: 0, kind: 'initial-load', at: 1_000, url: 'http://localhost:3000/products.html' },
      {
        index: 1,
        kind: 'click',
        at: 2_000,
        target: {
          description: "button 'Add to cart'",
          locators: [
            { kind: 'role', role: 'button', name: 'Add to cart', within: { kind: 'testid', attr: 'data-testid', value: 'product-card-1' } },
            { kind: 'css', selector: 'div:nth-of-type(1) > button', fragile: true },
          ],
        },
      },
      {
        index: 2,
        kind: 'click',
        at: 3_000,
        target: { description: "link 'Cart'", locators: [{ kind: 'role', role: 'link', name: 'Cart' }] },
        navigation: 'http://localhost:3000/cart.html',
      },
    ],
    notes: [],
    console: [{ step: 2, at: 3_200, level: 'warning', text: 'NaN passed to formatPrice', stack: ['formatPrice (http://localhost:3000/pricing.js:9:13)'] }],
    network: [
      { step: 1, at: 2_010, method: 'POST', url: 'http://localhost:3000/api/cart', resourceType: 'fetch', status: 201, durationMs: 12, requestBody: { text: '{"productId":1}' }, responseBody: { text: '{"items":[]}' } },
      { step: 2, at: 3_100, method: 'GET', url: 'http://localhost:3000/api/cart', resourceType: 'fetch', status: 200, durationMs: 4 },
    ],
    checkpoints: [
      {
        id: 1,
        afterStep: 2,
        at: 4_000,
        target: { description: 'cell', locators: [{ kind: 'testid', attr: 'data-testid', value: 'cart-total' }] },
        actual: { text: '$0', visible: true, html: '<td data-testid="cart-total">$0</td>' },
        expected: 'Total should be $42 (2 x $21)',
        contextOnly: false,
        screenshots: { region: 'blob_r1', viewport: 'blob_v1' },
      },
    ],
    redactions: 0,
  };
}
