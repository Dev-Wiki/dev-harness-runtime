#!/usr/bin/env node
import { runRepositoryCli } from './repository-cli.mjs';

const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  process.exitCode = await runRepositoryCli(process.argv.slice(2), {
    out: (value) => process.stdout.write(value),
    error: (value) => process.stderr.write(value),
  }, controller.signal);
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
