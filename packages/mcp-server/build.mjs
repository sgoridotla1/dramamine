import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies (ws) call require() for Node built-ins.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __strCreateRequire } from 'node:module';\nconst require = __strCreateRequire(import.meta.url);" },
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [join(root, 'src/index.ts')], outfile: join(root, 'dist/index.js') });
// The plugin's monitor: wakes the agent when the user sends a recording.
await build({ ...common, entryPoints: [join(root, 'src/monitor.ts')], outfile: join(root, 'dist/monitor.js') });

chmodSync(join(root, 'dist/index.js'), 0o755);

// The Claude Code plugin ships the bundled server next to its skill.
const pluginServer = join(root, '../../plugin/server');
mkdirSync(pluginServer, { recursive: true });
copyFileSync(join(root, 'dist/index.js'), join(pluginServer, 'str-mcp.js'));
copyFileSync(join(root, 'dist/monitor.js'), join(pluginServer, 'str-monitor.js'));
