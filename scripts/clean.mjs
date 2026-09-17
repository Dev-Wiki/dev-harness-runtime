import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Only known compiler output directories; fixtures and source trees are preserved.
for (const entry of readdirSync('packages', { withFileTypes: true })) {
  if (entry.isDirectory()) rmSync(join('packages', entry.name, 'dist'), { recursive: true, force: true });
}
rmSync('build/dist', { recursive: true, force: true });
