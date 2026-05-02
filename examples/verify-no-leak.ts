import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PATTERNS: Array<[string, RegExp]> = [
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['google', /AIza[A-Za-z0-9_-]{20,}/],
];

const CAPTURE_DIR = join('.harness', 'captures');
const CAPTURE_FILES = [
  join(CAPTURE_DIR, '01-host-only.jsonl'),
  join(CAPTURE_DIR, '02-opencode-host-only.jsonl'),
];

let totalLeaks = 0;
let inspected = 0;

for (const path of CAPTURE_FILES) {
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) {
    console.log(`· skip ${path} (not present — example not run yet)`);
    continue;
  }
  inspected++;
  let leaks = 0;
  for (const [name, pat] of PATTERNS) {
    const match = content.match(pat);
    if (match) {
      console.error(`✗ LEAK in ${path}: pattern "${name}"`);
      console.error(`  Sample: ${match[0].slice(0, 12)}…`);
      leaks++;
    }
  }
  if (leaks === 0) {
    console.log(`✓ ${path} — clean (${content.length} bytes)`);
  }
  totalLeaks += leaks;
}

if (inspected === 0) {
  console.error('No capture files found. Run an example first:');
  console.error('  pnpm host-only      # Claude SDK adapter');
  console.error('  pnpm opencode-only  # OpenCode CLI adapter');
  process.exit(2);
}

if (totalLeaks > 0) {
  console.error(
    `\nVerification FAILED: ${totalLeaks} leak(s). ` +
      `Check redactCapture() in packages/agent-adapter/src/capture.ts.`
  );
  process.exit(1);
}

console.log(`\n✓ ${inspected} capture file(s) clean. No credential patterns leaked.`);
