#!/usr/bin/env bun
import { run } from './main.ts';

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(code);
