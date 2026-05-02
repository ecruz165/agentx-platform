import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileBroker } from '@agentx/auth-lib';
import { FileCaptureSink, OpenCodeCliAdapter } from '@agentx/agent-adapter';

const authPath = join(homedir(), '.agentx', 'auth.json');
const capturePath = join('.harness', 'captures', '02-opencode-host-only.jsonl');

const broker = new FileBroker(authPath);
const capture = new FileCaptureSink(capturePath);

const adapter = new OpenCodeCliAdapter({
  broker,
  capture,
  // Override these if your local opencode lives elsewhere or expects a different model:
  // bin: '/usr/local/bin/opencode',
  // model: 'anthropic/claude-opus-4-7',
});

const text = await adapter.invoke('Reply with exactly the word "hello".');
console.log('OpenCode said:', text.trim());

await capture.close();
console.log(`Capture written to ${capturePath}. Run: pnpm verify`);
