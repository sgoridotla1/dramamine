import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  outdir: out,
  bundle: true,
  target: 'chrome120',
  sourcemap: 'inline',
  logLevel: 'warning',
};

// The service worker and extension pages are ES modules.
await build({
  ...common,
  format: 'esm',
  entryPoints: {
    sw: join(root, 'src/sw/index.ts'),
    sidepanel: join(root, 'src/sidepanel/index.ts'),
    connect: join(root, 'src/connect/index.ts'),
  },
});

// Content scripts are classic scripts.
await build({
  ...common,
  format: 'iife',
  entryPoints: { content: join(root, 'src/content/index.ts') },
});

cpSync(join(root, 'static'), out, { recursive: true });
