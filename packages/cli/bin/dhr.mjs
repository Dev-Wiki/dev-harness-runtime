#!/usr/bin/env node
import { runCli } from '../dist/index.js';

process.exitCode = runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  error: (text) => process.stderr.write(text),
});
