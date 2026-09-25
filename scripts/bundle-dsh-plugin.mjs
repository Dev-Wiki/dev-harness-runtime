import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await build({
  entryPoints: [join(root, 'packages/adapter-dsh/dist/plugin.js')],
  outfile: join(root, 'packages/adapter-dsh/dist/plugin.bundle.js'),
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  metafile: true,
  banner: { js: "import { createRequire as __dhrCreateRequire } from 'node:module'; const require = __dhrCreateRequire(import.meta.url);" },
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error(`DSH plugin bundle retained an external dependency: ${dependency.path}`);
    }
  }
}
