import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileBroker } from '@agentx/auth-lib';
import { ClaudeSdkAdapter, FileEventSubscriber } from '@agentx/agent-adapter';

const authPath = join(homedir(), '.agentx', 'auth.json');
const capturePath = join('.harness', 'captures', '01-host-only.jsonl');

const broker = new FileBroker(authPath);
const adapter = new ClaudeSdkAdapter({ broker });

const file = new FileEventSubscriber(capturePath);
const unsubscribe = adapter.events.subscribe(file.handler);

const text = await adapter.invoke({ user: 'Reply with exactly the word "hello".' });
console.log('Claude SDK said:', text);

unsubscribe();
await file.drain();
console.log(`Capture written to ${capturePath}. Run: pnpm verify`);
