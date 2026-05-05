#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AuthStore, fetchGitHubUsername, loginGitHubCopilot, type Provider } from '@agentx/auth-lib';
import { udsRequest } from './uds-client.ts';
import {
  findProduct,
  listProductIds,
  readWorkspaceConfig,
  WorkspaceConfigError,
  type ProductConfig,
  type WorkspaceConfig,
} from './workspace-config.ts';

/**
 * Path conventions (per prd-workspace-template):
 *   - Auth file is per-user, lives at ~/.agentx/auth.json (decision #5).
 *   - Sockets are workspace-scoped at <workspace>/.harness/run/<service>.sock.
 *     In containerized deployment (MVP-1+), the host's `<workspace>/.harness/run/`
 *     bind-mounts to `~/.harness/run/` inside the container.
 *   - Session is per-user at ~/.agentx/session.json.
 *
 * Workspace discovery: walk up from CWD looking for a `.harness/` directory
 * (the standard "anchor" pattern, like git's `.git/`). Containers (MVP-1+)
 * set HARNESS_WORKSPACE explicitly at spawn so this fallback isn't needed.
 */
const ORG_DIR = join(homedir(), '.agentx');
const AUTH_PATH = join(ORG_DIR, 'auth.json');
const SESSION_PATH = join(ORG_DIR, 'session.json');
const WORKSPACE_ROOT = findWorkspaceRoot();
const SOCKET_DIR = join(WORKSPACE_ROOT, '.harness', 'run');
const HARNESS_SOCKET = join(SOCKET_DIR, 'harness.sock');
const MEMORY_SOCKET = join(SOCKET_DIR, 'memory.sock');
const CONTEXT_SOCKET = join(SOCKET_DIR, 'context.sock');
const WORKSPACE_CONFIG_PATH = WORKSPACE_ROOT;

type Session = Record<string, string>;

function findWorkspaceRoot(): string {
  if (process.env.HARNESS_WORKSPACE) return process.env.HARNESS_WORKSPACE;
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, '.harness'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

async function main() {
  const [namespace, ...rest] = process.argv.slice(2);

  switch (namespace) {
    case 'auth':
      return handleAuth(rest);
    case 'server':
      return handleServer(rest);
    case 'session':
      return handleSession(rest);
    case 'memory':
      return handleMemory(rest);
    case 'context':
      return handleContext(rest);
    case 'project':
      return handleProject(rest);
    case 'submit':
      return handleSubmit(rest);
    case 'tui':
      await import('./tui.ts');
      return;
    case 'jobs-tui':
      await import('./jobs-tui.ts');
      return;
    default:
      usage();
      process.exit(2);
  }
}

async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  try {
    const cfg = await readWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    if (!cfg) {
      die(
        `No harness-workspace.yml found in ${WORKSPACE_CONFIG_PATH}.\n` +
          `Create one or run from a workspace directory.`
      );
    }
    return cfg;
  } catch (err) {
    if (err instanceof WorkspaceConfigError) die(err.message);
    throw err;
  }
}

async function handleProject(args: string[]) {
  const [verb, idArg] = args;
  const cfg = await loadWorkspaceConfig();

  if (verb === 'list') {
    console.log(`Workspace: ${cfg.workspace.id}\n`);
    console.log(`Products (${cfg.workspace.products.length}):`);
    for (const p of cfg.workspace.products) {
      const repoNames = p.repos.map((r) => r.name).join(', ');
      console.log(`  - ${p.id}${p.description ? ` — ${p.description}` : ''}`);
      console.log(`      repos: ${repoNames || '(none)'}`);
    }
    return;
  }

  if (verb === 'show') {
    if (!idArg) die('Usage: harness project show <id>');
    const product = findProduct(cfg, idArg);
    if (!product) {
      die(`Product not found: ${idArg}\nKnown: ${listProductIds(cfg).join(', ')}`);
    }
    console.log(`Product: ${product.id}`);
    if (product.description) console.log(`Description: ${product.description}`);
    console.log(`Repos (${product.repos.length}):`);
    for (const r of product.repos) {
      console.log(`  - ${r.name.padEnd(20)} ${r.cloneUrl}  (${r.baseRef})`);
      if (r.path) console.log(`    mount: ${r.path}`);
    }
    if (product.resources) {
      const parts: string[] = [];
      if (product.resources.memory) parts.push(`memory=${product.resources.memory}`);
      if (product.resources.cpu !== undefined) parts.push(`cpu=${product.resources.cpu}`);
      if (parts.length) console.log(`Resources: ${parts.join(', ')}`);
    }
    return;
  }

  die('Usage: harness project <list|show> [id]');
}

async function handleSubmit(args: string[]) {
  const opts = parseSubmitArgs(args);
  const cfg = await loadWorkspaceConfig();
  const session = await readSession();

  const productId = opts.product ?? session.productId;
  if (!productId) {
    die(
      'No productId provided. Pass --product <id>, or run:\n' +
        `  harness session set productId <id>\nKnown: ${listProductIds(cfg).join(', ')}`
    );
  }
  const product = findProduct(cfg, productId);
  if (!product) {
    die(`Product not registered: ${productId}\nKnown: ${listProductIds(cfg).join(', ')}`);
  }

  const input = await resolveInput(opts);
  if (!input) {
    die('No input provided. Use --input <file>, --input-text "<text>", or pipe via stdin.');
  }

  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const body = {
    jobId,
    name: opts.name,
    pipeline: opts.pipeline,
    productId: product.id,
    productRepos: product.repos.map((r) => r.name),
    input,
    submittedAt: new Date().toISOString(),
  };

  const label = opts.name ? `${jobId} ("${opts.name}")` : jobId;
  console.log(`Submitting ${label} to harness-server (${HARNESS_SOCKET})…`);
  console.log(`  pipeline:   ${opts.pipeline}`);
  console.log(`  productId:  ${product.id}`);
  console.log(`  repos:      ${body.productRepos.join(', ')}`);
  if (opts.name) console.log(`  name:       ${opts.name}`);
  console.log(`  input:      ${input.length} chars`);

  const resp = await udsRequest(HARNESS_SOCKET, 'POST', '/v1/jobs', body);
  console.log('\nServer response:');
  print(resp.body);
}

interface SubmitOptions {
  pipeline: string;
  product?: string;
  name?: string;
  inputFile?: string;
  inputText?: string;
}

function parseSubmitArgs(args: string[]): SubmitOptions {
  const positional: string[] = [];
  const opts: SubmitOptions = { pipeline: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--product') opts.product = args[++i];
    else if (a === '--name') opts.name = args[++i];
    else if (a === '--input') opts.inputFile = args[++i];
    else if (a === '--input-text') opts.inputText = args[++i];
    else if (a?.startsWith('--')) die(`Unknown flag: ${a}`);
    else if (a !== undefined) positional.push(a);
  }
  if (positional.length === 0) {
    die(
      'Usage: harness submit <pipeline> [--product <id>] [--name "<title>"] [--input <file>|--input-text "<text>"]'
    );
  }
  opts.pipeline = positional[0]!;
  return opts;
}

async function resolveInput(opts: SubmitOptions): Promise<string | null> {
  if (opts.inputText) return opts.inputText;
  if (opts.inputFile) {
    const path = resolve(opts.inputFile);
    return await readFile(path, 'utf8');
  }
  if (!process.stdin.isTTY) {
    return await readStdin();
  }
  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function handleAuth(args: string[]) {
  const [verb, providerArg] = args;
  const store = new AuthStore(AUTH_PATH);

  if (verb === 'login') {
    const provider = (providerArg ?? 'github-copilot') as Provider;
    if (provider !== 'github-copilot') {
      die(`Login flow not implemented for ${provider}. Edit ${AUTH_PATH} directly.`);
    }
    process.stderr.write(`\n→ Starting GitHub Device Flow for Copilot…\n`);
    const result = await loginGitHubCopilot();
    const username = await fetchGitHubUsername(result.apiKey);
    await store.setProvider('github-copilot', {
      apiKey: result.apiKey,
      tokenType: result.tokenType,
      scope: result.scope,
      expiresAt: result.expiresAt,
      username: username ?? undefined,
    });
    console.log(
      `✓ github-copilot authenticated${username ? ` as @${username}` : ''}. Token saved to ${AUTH_PATH}`
    );
    console.log(`  Length: ${result.apiKey.length}, scope: ${result.scope || '(default)'}`);
    return;
  }

  if (verb === 'status') {
    const status = await store.status();
    if (Object.keys(status).length === 0) {
      console.log('No providers configured.');
      return;
    }
    for (const [provider, info] of Object.entries(status)) {
      const tag = info.authenticated ? '✓' : '✗';
      const parts: string[] = [];
      if (info.authenticated) {
        parts.push(`length=${info.tokenLength}`);
        if (info.username) parts.push(`@${info.username}`);
        if (info.scope) parts.push(`scope=${info.scope}`);
        if (info.hasCopilotSessionToken && info.copilotSessionExpiresIn !== undefined) {
          const min = Math.max(0, Math.round(info.copilotSessionExpiresIn / 60));
          parts.push(`copilot-session: ${min}m left`);
        }
      } else {
        parts.push('placeholder — not authenticated');
      }
      console.log(`  ${tag} ${provider}: ${parts.join(', ')}`);
    }
    return;
  }

  if (verb === 'logout') {
    if (!providerArg) die('Usage: harness auth logout <provider>');
    const removed = await store.removeProvider(providerArg as Provider);
    console.log(removed ? `Removed ${providerArg}.` : `${providerArg} was not configured.`);
    return;
  }

  die('Usage: harness auth <login|status|logout> [provider]');
}

async function handleServer(args: string[]) {
  const [verb] = args;

  if (verb === 'status') {
    const sockets: Array<[string, string]> = [
      ['harness', HARNESS_SOCKET],
      ['memory', MEMORY_SOCKET],
      ['context', CONTEXT_SOCKET],
    ];
    for (const [name, path] of sockets) {
      const live = existsSync(path);
      console.log(`  ${live ? '✓' : '✗'} ${name.padEnd(8)} ${live ? 'running' : 'down  '}  ${path}`);
    }
    return;
  }

  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    console.error(`MVP-0: server lifecycle is via 'pnpm dev:servers' in a separate terminal.`);
    console.error(`MVP-1+: '${verb}' will wrap docker-compose per workspace-setup-cli F13–F16.`);
    process.exit(2);
  }

  die('Usage: harness server <status|start|stop>');
}

async function handleSession(args: string[]) {
  const [verb, key, ...rest] = args;
  const session = await readSession();

  if (verb === 'show') {
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  if (verb === 'get') {
    if (!key) die('Usage: harness session get <key>');
    console.log(session[key] ?? '');
    return;
  }
  if (verb === 'set') {
    if (!key || rest.length === 0) die('Usage: harness session set <key> <value>');
    session[key] = rest.join(' ');
    await writeSession(session);
    console.log(`session.${key} = ${session[key]}`);
    return;
  }
  die('Usage: harness session <show|get|set>');
}

async function handleMemory(args: string[]) {
  const session = await readSession();
  const [verb, ...rest] = args;

  if (verb === 'query') {
    const [key] = rest;
    if (!key) die('Usage: harness memory query <key>');
    const resp = await udsRequest(MEMORY_SOCKET, 'POST', '/v1/memory/query', {
      key,
      productId: requireProductId(session),
    });
    print(resp.body);
    return;
  }
  if (verb === 'put') {
    const [key, ...valueParts] = rest;
    if (!key || valueParts.length === 0) die('Usage: harness memory put <key> <value>');
    const resp = await udsRequest(MEMORY_SOCKET, 'POST', '/v1/memory/put', {
      key,
      value: valueParts.join(' '),
      productId: requireProductId(session),
    });
    print(resp.body);
    return;
  }
  die('Usage: harness memory <query|put>');
}

async function handleContext(args: string[]) {
  const session = await readSession();
  const [verb, ...rest] = args;

  if (verb === 'query') {
    const q = rest.join(' ');
    if (!q) die('Usage: harness context query <text>');
    const resp = await udsRequest(CONTEXT_SOCKET, 'POST', '/v1/context/query', {
      q,
      productId: requireProductId(session),
    });
    print(resp.body);
    return;
  }
  die('Usage: harness context query <text>');
}

async function readSession(): Promise<Session> {
  try {
    return JSON.parse(await readFile(SESSION_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function writeSession(session: Session): Promise<void> {
  await mkdir(ORG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(SESSION_PATH, 0o600);
}

function requireProductId(session: Session): string {
  const id = session.productId;
  if (!id) {
    die(
      'productId not set. Run: harness session set productId <id>\n' +
        '(Decision #4: every memory/context call must be product-scoped.)'
    );
  }
  return id;
}

function print(body: unknown): void {
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function usage(): void {
  console.error(
    [
      'Usage:',
      '  harness auth <login|status|logout> [provider]   # default provider: github-copilot',
      '  harness server <status|start|stop>',
      '  harness tui                                   # interactive ops dashboard',
      '  harness jobs-tui                              # 3-column jobs/agents/events viewer',
      '  harness session <show|get|set> [key] [value]',
      '  harness project <list|show> [id]',
      '  harness submit <pipeline> [--product <id>] [--name "<title>"] [--input <file>|--input-text "<text>"]',
      '  harness memory <query|put> <key> [value]',
      '  harness context query <text>',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
