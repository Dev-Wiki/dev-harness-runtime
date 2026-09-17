import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await build({
  entryPoints: [join(root, 'packages/cli/dist/index.js')],
  outfile: join(root, 'packages/cli/dist/bundle.js'),
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'linked',
  metafile: true,
  // Bundled CommonJS dependencies may require Node builtins from an ESM entry.
  banner: { js: "import { createRequire as __dhrCreateRequire } from 'node:module'; const require = __dhrCreateRequire(import.meta.url);" },
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error(`CLI bundle retained an external dependency: ${dependency.path}`);
    }
  }
}
