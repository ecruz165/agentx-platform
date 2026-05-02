import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, FileBroker, callCopilot } from '@agentx/auth-lib';

const authPath = join(homedir(), '.agentx', 'auth.json');
const broker = new FileBroker(authPath);
const store = new AuthStore(authPath);

console.log('=== Stub agent — auth propagation demo ===\n');
console.log(`Broker: FileBroker(${authPath})`);
console.log(`Asking broker for github-copilot credential…\n`);

let cred;
try {
  cred = await broker.getCredential('github-copilot');
  console.log('✓ Credential received by stub agent');
  console.log(`  provider:   ${cred.provider}`);
  console.log(`  source:     ${cred.source}`);
  console.log(`  tokenType:  ${cred.tokenType ?? '(not set)'}`);
  console.log(`  scope:      ${cred.scope ?? '(not set)'}`);
  console.log(`  length:     ${cred.apiKey.length} chars`);
  console.log(`  prefix:     ${cred.apiKey.slice(0, 4)}…`);
  if (cred.expiresAt) console.log(`  expiresAt:  ${cred.expiresAt}`);
  console.log('');
  console.log('Auth propagation chain (read path) verified:');
  console.log('  GitHub OAuth → harness CLI → ~/.agentx/auth.json (mode 0600)');
  console.log('  → FileBroker (chmod gate) → stub agent\n');
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error('\nRun: pnpm harness auth login github-copilot');
  process.exit(1);
}

console.log('=== Stage 2: real Copilot call ===\n');
console.log('Stub agent will now exchange github_token → copilot session token,');
console.log('then call api.githubcopilot.com/chat/completions with a tiny prompt.\n');

try {
  const resp = await callCopilot(
    store,
    [
      { role: 'system', content: 'Reply with a single short sentence.' },
      { role: 'user', content: 'Say hello in 5 words or less.' },
    ],
    'gpt-4o'
  );
  const text = resp.choices[0]?.message.content ?? '';
  console.log(`✓ Copilot replied: ${text.trim()}`);
  if (resp.usage) {
    console.log(
      `  tokens: prompt=${resp.usage.prompt_tokens ?? '?'}, completion=${resp.usage.completion_tokens ?? '?'}, total=${resp.usage.total_tokens ?? '?'}`
    );
  }
  console.log('');
  console.log('Full chain verified:');
  console.log('  GitHub Device Flow → github_token → ~/.agentx/auth.json');
  console.log('  → broker → stub agent → callCopilot()');
  console.log('  → api.github.com/copilot_internal/v2/token (session-token exchange + cache)');
  console.log('  → api.githubcopilot.com/chat/completions');
  console.log('  → response back to agent.\n');
  console.log('A real Copilot adapter (v1.x) wraps the same callCopilot() in the');
  console.log('AgentAdapter interface so it plugs into the same capture pipeline.');
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
