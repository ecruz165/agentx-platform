import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileBroker } from '@agentx/auth-lib';
import { ClaudeSdkAdapter, FileCaptureSink } from '@agentx/agent-adapter';

const authPath = join(homedir(), '.agentx', 'auth.json');
const capturePath = join('.harness', 'captures', '01-host-only.jsonl');

const broker = new FileBroker(authPath);
const capture = new FileCaptureSink(capturePath);
const adapter = new ClaudeSdkAdapter({ broker, capture });

const text = await adapter.invoke('Reply with exactly the word "hello".');
console.log('Claude SDK said:', text);

await capture.close();
console.log(`Capture written to ${capturePath}. Run: pnpm verify`);
