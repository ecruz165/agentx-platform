/**
 * Static registry of known LLM providers and the models they serve.
 *
 * Per memory `project_per_worker_model_subscription`, this is the source of
 * truth for resolving accept-list bindings (`<provider>:<model>`). The
 * registry is intentionally hardcoded in v1:
 *   - Reduces attack surface (no untrusted JSON parsing at startup)
 *   - Lets TypeScript exhaustively check provider ids
 *   - Versioning aligns with package version (model addition = release)
 *
 * Future widening: load from JSON to support custom-hosted vLLM / TGI
 * endpoints. Requires relaxing `Provider` from a closed union to `string`.
 * Defer until a real use case lands.
 *
 * Maintenance rule: when a vendor releases a new model, add it here. The
 * model id should be the stable handle catalog authors will use; populate
 * `vendorModelId` only when there's real divergence (Bedrock's verbose ARN-
 * style ids are the canonical example).
 */

import type { LLMProvider, ResolvedRegistryEntry, ToolId } from './llm-provider.ts';

/**
 * The closed set of known tool ids (mirrors the `ToolId` union). The
 * binding parser uses this to disambiguate 3-part `<tool>:<provider>:<model>`
 * specs from 2-part `<provider>:<model>` shorthands without needing a
 * delimiter change. If the first segment matches a known tool, treat as
 * 3-part; otherwise treat as 2-part (the segment is the provider id).
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  'claude-sdk',
  'openai-api',
  'opencode-cli',
  'copilot-api',
]);

const ANTHROPIC: LLMProvider = {
  id: 'anthropic',
  name: 'Anthropic (direct)',
  authMethods: ['api-key'],
  models: [
    {
      id: 'claude-opus-4-7',
      type: 'text',
      contextWindow: 200_000,
      capabilities: ['tools', 'vision', 'thinking'],
      costTier: 'frontier',
    },
    {
      id: 'claude-sonnet-4-6',
      type: 'text',
      contextWindow: 200_000,
      capabilities: ['tools', 'vision', 'thinking'],
      costTier: 'frontier',
    },
    {
      id: 'claude-haiku-4-5',
      type: 'text',
      contextWindow: 200_000,
      capabilities: ['tools', 'vision'],
      costTier: 'small',
    },
  ],
};

const OPENAI: LLMProvider = {
  id: 'openai',
  name: 'OpenAI',
  authMethods: ['api-key'],
  models: [
    {
      id: 'gpt-4o',
      type: 'text',
      contextWindow: 128_000,
      capabilities: ['tools', 'vision'],
      costTier: 'frontier',
    },
    {
      id: 'gpt-4o-mini',
      type: 'text',
      contextWindow: 128_000,
      capabilities: ['tools'],
      costTier: 'small',
    },
    { id: 'text-embedding-3-small', type: 'text-embedding', embeddingDim: 1536 },
    { id: 'text-embedding-3-large', type: 'text-embedding', embeddingDim: 3072 },
  ],
};

const GOOGLE: LLMProvider = {
  id: 'google',
  name: 'Google (Gemini)',
  authMethods: ['api-key'],
  models: [
    {
      id: 'gemini-1.5-pro',
      type: 'text',
      contextWindow: 2_000_000,
      capabilities: ['tools', 'vision'],
      costTier: 'frontier',
    },
    {
      id: 'gemini-1.5-flash',
      type: 'text',
      contextWindow: 1_000_000,
      capabilities: ['tools', 'vision'],
      costTier: 'mid',
    },
    { id: 'text-embedding-004', type: 'text-embedding', embeddingDim: 768 },
  ],
};

/**
 * GitHub Copilot is a meta-vendor — its catalog reflects the underlying
 * models Copilot proxies to. Billing/auth happens against GitHub; the
 * model behavior is the upstream vendor's. Pair-grain accept-list
 * (`github-copilot:claude-3-5-sonnet`) lets catalogs distinguish this
 * binding from `anthropic:claude-3-5-sonnet` (direct).
 */
const GITHUB_COPILOT: LLMProvider = {
  id: 'github-copilot',
  name: 'GitHub Copilot (meta-vendor)',
  authMethods: ['device-code'],
  models: [
    { id: 'gpt-4o', type: 'text', contextWindow: 128_000, capabilities: ['tools', 'vision'] },
    { id: 'claude-3-5-sonnet', type: 'text', contextWindow: 200_000, capabilities: ['tools'] },
    { id: 'gemini-1.5-pro', type: 'text', contextWindow: 2_000_000, capabilities: ['tools'] },
  ],
};

/**
 * AWS Bedrock — second meta-vendor. Hosts Anthropic + Meta + Mistral + Amazon
 * native models behind a uniform API. Default provider on AWS-deployed
 * harness (policy via `providerPreferenceOverride`, not architecture).
 *
 * `vendorModelId` is required here: Bedrock's actual model ids are versioned
 * ARN-style strings. Catalog authors use the stable short handle; the broker
 * translates at adapter-call time.
 */
const BEDROCK: LLMProvider = {
  id: 'bedrock',
  name: 'AWS Bedrock (meta-vendor)',
  authMethods: ['iam-task-role', 'api-key'],
  models: [
    {
      id: 'claude-opus-4-7-bedrock',
      type: 'text',
      vendorModelId: 'anthropic.claude-opus-4-7-20251101-v1:0',
      contextWindow: 200_000,
      capabilities: ['tools', 'vision', 'thinking'],
      costTier: 'frontier',
    },
    {
      id: 'claude-haiku-4-5-bedrock',
      type: 'text',
      vendorModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      contextWindow: 200_000,
      capabilities: ['tools'],
      costTier: 'small',
    },
    {
      id: 'titan-v2',
      type: 'text-embedding',
      vendorModelId: 'amazon.titan-embed-text-v2:0',
      embeddingDim: 1024,
    },
    {
      id: 'llama-3-70b',
      type: 'text',
      vendorModelId: 'meta.llama3-70b-instruct-v1:0',
      contextWindow: 8_000,
    },
  ],
};

/**
 * Local Qwen via Docker Model Runner. No auth needed — endpoint is
 * `agent-llm:8080` inside the dev compose network. Sibling embedder served
 * by `ai/qwen3-embedding` at the same endpoint shape.
 *
 * Per `project_embedder_choice`: 1024-dim across local-qwen + bedrock-titan
 * by design, so embedded collections survive the local→cloud move.
 */
const LOCAL_QWEN: LLMProvider = {
  id: 'local-qwen',
  name: 'Local Qwen (Docker Model Runner)',
  authMethods: [],
  models: [
    // vendorModelId fields name the actual Docker Model Runner tag the
    // local model server expects in chat-completion requests. The `id`
    // field is the stable handle catalog authors use; vendorModelId is
    // what flows through OpenCode → DMR as the `model:` field. Choice of
    // tag/quant is a deployment detail (project_embedder_choice memory):
    // 0.6B-Q4_K_M is the smallest viable chat tag (~456 MiB pull).
    {
      id: 'qwen3',
      type: 'text',
      vendorModelId: 'ai/qwen3:0.6B-Q4_K_M',
      contextWindow: 32_000,
      capabilities: ['tools'],
      costTier: 'small',
    },
    {
      id: 'qwen3-coder',
      type: 'text',
      vendorModelId: 'ai/qwen3-coder:8B-Q4_K_M',
      contextWindow: 32_000,
      capabilities: ['tools'],
      costTier: 'small',
    },
    {
      id: 'qwen3-embedding',
      type: 'text-embedding',
      vendorModelId: 'ai/qwen3-embedding:0.6B-F16',
      embeddingDim: 1024,
    },
  ],
};

export const BUILT_IN_PROVIDERS: readonly LLMProvider[] = [
  ANTHROPIC,
  OPENAI,
  GOOGLE,
  GITHUB_COPILOT,
  BEDROCK,
  LOCAL_QWEN,
];

/**
 * Look up a provider by id. Returns undefined if not in the registry.
 *
 * Catalog accept-list entries arrive as `<provider>:<model>` strings; the
 * broker calls this to resolve the provider half before walking the model
 * list. Throwing here would couple this layer to "missing provider" error
 * UX — keep it pure.
 */
export function findProvider(id: string): LLMProvider | undefined {
  return BUILT_IN_PROVIDERS.find((p) => p.id === id);
}

/**
 * Look up a binding spec against the registry. Supports two shapes:
 *
 *   3-part:  `<tool>:<provider>:<model>`   e.g. `openai-api:openai:gpt-4o`
 *   2-part:  `<provider>:<model>`          e.g. `openai:gpt-4o` (default tool)
 *
 * The first segment determines the shape: if it matches a known tool id
 * (see KNOWN_TOOLS), the spec is parsed as 3-part; otherwise as 2-part.
 * This keeps backwards compat — 2-part bindings continue to work
 * unchanged — while letting catalogs explicitly pin a tool when the
 * choice matters (e.g., `opencode-cli:openai:gpt-4o` to route OpenAI
 * through opencode instead of the direct API).
 *
 * Per memory `project_three_axis_binding`. Returns the registry entry
 * with the parsed tool field (undefined for 2-part), or undefined when
 * the provider/model don't exist.
 */
export function findBinding(spec: string): ResolvedRegistryEntry | undefined {
  const firstColon = spec.indexOf(':');
  if (firstColon === -1) return undefined;
  const firstSegment = spec.slice(0, firstColon);
  const rest = spec.slice(firstColon + 1);
  if (!firstSegment || !rest) return undefined;

  let tool: ToolId | undefined;
  let providerId: string;
  let modelId: string;

  if (KNOWN_TOOLS.has(firstSegment)) {
    // 3-part form: <tool>:<provider>:<model>
    const secondColon = rest.indexOf(':');
    if (secondColon === -1) return undefined;
    providerId = rest.slice(0, secondColon);
    modelId = rest.slice(secondColon + 1);
    if (!providerId || !modelId) return undefined;
    tool = firstSegment as ToolId;
  } else {
    // 2-part form: <provider>:<model> — first segment is the provider.
    providerId = firstSegment;
    modelId = rest;
  }

  const provider = findProvider(providerId);
  if (!provider) return undefined;
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return undefined;
  return tool !== undefined ? { tool, provider, model } : { provider, model };
}
