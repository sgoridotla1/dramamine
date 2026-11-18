// Fixture app with deliberate bugs, used by e2e tests and for trying STR by hand.
// Run directly with `npm start -w @str/fixture-app` (PORT defaults to 5173).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export const PRODUCTS = [
  'Coffee mug', 'Tea pot', 'Water bottle', 'Lunch box', 'Thermos', 'Espresso cup',
  'Milk jug', 'Sugar bowl', 'Teaspoon set', 'Coaster pack', 'Cake stand', 'Bread bin',
].map((name, i) => ({ id: i + 1, name, price: 21 + i * 2 }));

/**
 * Variants switch the served app between states that tests need:
 * - fixed:   serve the corrected pricing module instead of the buggy one
 * - renamed: rename the checkout button's test id (locator drift)
 */
export function createFixtureServer({ port = 0 } = {}) {
  const state = { cart: [], variant: { fixed: false, renamed: false }, requests: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.requests.push(`${req.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__fixture/')) {
        return await handleApi(req, res, url, state);
      }
      return await serveStatic(res, url, state);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        state,
        setVariant: (v) => Object.assign(state.variant, v),
        reset: () => {
          state.cart = [];
          state.requests = [];
          state.variant = { fixed: false, renamed: false };
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, url, state) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/products':
      return json(res, 200, { products: PRODUCTS });
    case 'GET /api/cart':
      return json(res, 200, { items: state.cart });
    case 'POST /api/cart': {
      const { productId } = await readBody(req);
      const product = PRODUCTS.find((p) => p.id === productId);
      if (!product) return json(res, 404, { error: 'unknown product' });
      const line = state.cart.find((l) => l.productId === productId);
      if (line) line.qty += 1;
      else state.cart.push({ productId, name: product.name, price: product.price, qty: 1 });
      return json(res, 201, { items: state.cart });
    }
    case 'POST /api/login': {
      const { username } = await readBody(req);
      return json(res, 200, { user: { name: username }, accessToken: 'tok_live_9f8e7d6c5b4a', refresh_token: 'rt_123' });
    }
    case 'GET /api/fail':
      return json(res, 500, { error: 'database is on fire', code: 'E_FIRE' });
    case 'GET /api/big':
      return json(res, 200, { blob: 'x'.repeat(50 * 1024) });
    case 'POST /api/created':
      return json(res, 201, { id: 42 });
    case 'POST /__fixture/reset':
      state.cart = [];
      return json(res, 200, { ok: true });
    case 'POST /__fixture/variant':
      Object.assign(state.variant, await readBody(req));
      return json(res, 200, state.variant);
    default:
      return json(res, 404, { error: `no route ${route}` });
  }
}

async function serveStatic(res, url, state) {
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (path === '/pricing.js' && state.variant.fixed) path = '/pricing.fixed.js';
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  let body;
  try {
    body = await readFile(file, 'utf8');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  if (state.variant.renamed) body = body.replaceAll('data-testid="checkout-button"', 'data-testid="checkout-btn"');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await createFixtureServer({ port: Number(process.env.PORT ?? 5173) });
  console.log(`fixture app on ${fixture.url}`);
}
