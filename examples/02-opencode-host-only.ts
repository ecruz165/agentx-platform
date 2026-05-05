import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileBroker } from '@agentx/agent-auth-lib';
import { FileEventSubscriber, OpenCodeCliAdapter } from '@agentx/agent-adapter';

const authPath = join(homedir(), '.agentx', 'auth.json');
const capturePath = join('.harness', 'captures', '02-opencode-host-only.jsonl');

const broker = new FileBroker(authPath);

const adapter = new OpenCodeCliAdapter({
  broker,
  // Override these if your local opencode lives elsewhere or expects a different model:
  // bin: '/usr/local/bin/opencode',
  // model: 'anthropic/claude-opus-4-7',
});

const file = new FileEventSubscriber(capturePath);
const unsubscribe = adapter.events.subscribe(file.handler);

const text = await adapter.invoke({ user: 'Reply with exactly the word "hello".' });
console.log('OpenCode said:', text.trim());

unsubscribe();
await file.drain();
console.log(`Capture written to ${capturePath}. Run: pnpm verify`);
