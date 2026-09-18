import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const [entry, output] of [
  ['packages/adapter-codex/dist/executor/mcp-server.js', 'packages/adapter-codex/dist/executor/bridge.bundle.mjs'],
  ['packages/adapter-codex/dist/index.js', 'packages/adapter-codex/dist/adapter.bundle.js'],
]) {
  const result = await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, output),
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    banner: { js: "import { createRequire as __dhrCreateRequire } from 'node:module'; const require = __dhrCreateRequire(import.meta.url);" },
  });
  for (const bundled of Object.values(result.metafile.outputs)) {
    for (const dependency of bundled.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) {
        throw new Error(`Codex bundle retained an external dependency: ${dependency.path}`);
      }
    }
  }
}
