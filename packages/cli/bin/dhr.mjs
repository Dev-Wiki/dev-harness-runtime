#!/usr/bin/env node
import { runCli } from '../dist/bundle.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    error: (text) => process.stderr.write(text),
  }, { signal: controller.signal });
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
