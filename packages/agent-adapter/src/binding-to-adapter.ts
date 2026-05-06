/**
 * bindingToAdapter — converts a ResolvedBinding (from the auth-lib's
 * BindingResolver) into a concrete AgentAdapter ready to invoke.
 *
 * This is the binding-aware replacement for the orchestrator's
 * `defaultAdapterFactory`. Where the old factory dispatched on a
 * catalog-declared `adapter: claude-sdk | opencode-cli` id, this factory
 * dispatches on `binding.provider.id` — meaning the catalog can declare
 * model preferences (`accepts: [...]`) and the resolver picks at runtime
 * based on what's authenticated.
 *
 * Per memory `project_per_worker_model_subscription`:
 *   - direct anthropic     → ClaudeSdkAdapter (native SDK, full control)
 *   - openai / google      → OpenCodeCliAdapter (opencode handles vendors)
 *   - local-qwen           → OpenCodeCliAdapter with a configured endpoint
 *   - github-copilot       → throw — adapter gap, see provider-registry comment
 *   - bedrock              → throw — adapter gap (BedrockAdapter not built)
 *
 * Endpoint URLs for local providers come from the caller via
 * `options.localEndpoint`; the resolver itself is endpoint-agnostic. v1
 * default reads from env (AGENTX_LOCAL_QWEN_ENDPOINT) so a deployment can
 * override without a code change.
 */

import type { CredentialBroker, ResolvedBinding } from '@agentx/agent-auth-lib';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.ts';
import { OpenCodeCliAdapter } from './opencode-cli-adapter.ts';
import { CopilotChatAdapter } from './copilot-chat-adapter.ts';
import { OpenAiChatAdapter } from './openai-chat-adapter.ts';
import type { AgentAdapter } from './types.ts';

export interface BindingToAdapterOptions {
  /**
   * The CredentialBroker the adapter will use to fetch credentials.
   * For local bindings the adapter still receives a broker (the
   * OpenCodeCliAdapter contract requires one) but won't actually call it
   * since `endpoint` is set.
   */
  broker: CredentialBroker;
  /**
   * Endpoint resolver for local providers. Receives the provider id (e.g.
   * 'local-qwen') and returns the HTTP endpoint URL for that local model
   * server, or undefined if not configured. Defaults to
   * `defaultLocalEndpointResolver`, which reads from env vars.
   */
  localEndpoint?: (providerId: string) => string | undefined;
  /**
   * URL of a long-running `opencode serve` instance to attach to. When set,
   * any binding that resolves to OpenCodeCliAdapter (cloud openai/google,
   * any local-kind) will pass `serverUrl` to the adapter — invocations use
   * `opencode run --attach <url>` instead of standalone form. Per memory
   * `feedback_opencode_http_mode`. Caller (typically harness-pipeline)
   * owns the server lifecycle.
   */
  opencodeServerUrl?: string;
  /**
   * Path to the auth.json that holds the GitHub OAuth token used by
   * `CopilotChatAdapter`. Required when resolving a `github-copilot`
   * cloud binding — without it, `bindingToAdapter` throws because it
   * can't construct the adapter. Typically `~/.agentx/auth.json`
   * populated by `harness auth login github-copilot`.
   *
   * Why a path and not just a Credential? Copilot needs the long-lived
   * GitHub OAuth token + a separate cached short-lived session token,
   * with periodic refresh. The AuthStore handles that lifecycle; the
   * adapter reads through it directly.
   */
  copilotAuthPath?: string;
}

/**
 * True iff this binding will resolve to an `OpenCodeCliAdapter` when passed
 * to `bindingToAdapter` — i.e., the binding requires a running
 * `opencode serve` to share. Used by harness-pipeline at boot time for
 * lazy resource acquisition (`project_lazy_resource_acquisition` memory):
 * pure-anthropic pipelines skip the opencode-server spawn entirely.
 *
 * The mapping mirrors bindingToAdapter's own dispatch — keep them in sync
 * if a new adapter type is added.
 */
export function bindingNeedsOpenCode(binding: ResolvedBinding): boolean {
  if (binding.kind === 'local') return true;
  // Cloud bindings — anthropic uses ClaudeSdkAdapter, openai uses the
  // direct OpenAiChatAdapter, github-copilot uses CopilotChatAdapter,
  // bedrock isn't wired yet. Only google still routes through opencode
  // pending its own direct adapter.
  return binding.provider.id === 'google';
}

/**
 * Default endpoint resolver. Reads from process.env per provider id.
 * Returns undefined when nothing is configured — the factory throws
 * with an actionable error in that case.
 *
 * Mapping today:
 *   local-qwen → AGENTX_LOCAL_QWEN_ENDPOINT
 *
 * Add new local providers here as the registry grows.
 */
export function defaultLocalEndpointResolver(providerId: string): string | undefined {
  if (providerId === 'local-qwen') {
    return process.env.AGENTX_LOCAL_QWEN_ENDPOINT;
  }
  return undefined;
}

export function bindingToAdapter(
  binding: ResolvedBinding,
  options: BindingToAdapterOptions
): AgentAdapter {
  const { broker, localEndpoint = defaultLocalEndpointResolver, opencodeServerUrl } = options;

  if (binding.kind === 'local') {
    const endpoint = localEndpoint(binding.provider.id);
    if (!endpoint) {
      throw new Error(
        `bindingToAdapter: no endpoint configured for local provider "${binding.provider.id}". ` +
          `Set AGENTX_LOCAL_QWEN_ENDPOINT or pass options.localEndpoint.`
      );
    }
    // OpenCodeCliAdapter local-mode: writes a custom provider into
    // opencode.json pointing at this endpoint. The model spec passed to
    // OpenCode becomes `<providerId>/<vendorModelId|id>` — mirroring the
    // cloud branch's behavior. For local-qwen via DMR, vendorModelId is
    // the actual DMR-known id like `ai/qwen3:0.6B-Q4_K_M`; the registry's
    // `id` field is the stable handle catalog authors use.
    //
    // serverUrl when set means the adapter will use `--attach <url>`
    // against the harness-pipeline's shared opencode-server instead of
    // spawning standalone.
    const localModelId = binding.model.vendorModelId ?? binding.model.id;
    return new OpenCodeCliAdapter({
      broker,
      endpoint,
      endpointProviderId: binding.provider.id,
      model: `${binding.provider.id}/${localModelId}`,
      ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
    });
  }

  // Cloud binding from here on.
  const providerId = binding.provider.id;
  // For Bedrock the registry handle (e.g. claude-haiku-4-5-bedrock) is NOT
  // what the SDK takes — vendorModelId is. For everything else they're the
  // same and vendorModelId is undefined, so fall through to id.
  const modelId = binding.model.vendorModelId ?? binding.model.id;

  if (providerId === 'anthropic') {
    // ClaudeSdkAdapter doesn't go through opencode — direct SDK calls. The
    // opencodeServerUrl option is irrelevant here.
    return new ClaudeSdkAdapter({ broker, model: modelId });
  }

  if (providerId === 'openai') {
    // Direct OpenAI API call via OpenAiChatAdapter is the default for
    // openai bindings — simpler, lower-overhead, full control of the
    // model id. opencode-cli is also a valid path for openai (now that
    // OpenCodeCliAdapter properly registers the model in opencode.json
    // for cloud-mode); use it via the legacy `adapter: 'opencode-cli'`
    // catalog field when you want opencode's tool/agent surface around
    // an openai-backed model.
    return new OpenAiChatAdapter({ broker, model: modelId });
  }

  if (providerId === 'google') {
    // Google still routes through opencode-cli — no direct GeminiAdapter
    // yet (slice TBD when there's user demand). opencode's google
    // catalog has the common gemini-1.5-pro / -flash entries, plus the
    // cloud-mode model registration now ensures arbitrary ids work too.
    return new OpenCodeCliAdapter({
      broker,
      provider: providerId,
      model: `${providerId}/${modelId}`,
      ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
    });
  }

  if (providerId === 'github-copilot') {
    // Copilot has its own adapter — uses the AuthStore for session-token
    // caching + refresh, posts to api.githubcopilot.com/chat/completions
    // with the right Editor-Plugin-Version headers. Caller must supply
    // `copilotAuthPath` so the adapter knows where to read the GitHub
    // OAuth token from. Per memory `project_per_worker_model_subscription`.
    const authPath = options.copilotAuthPath;
    if (!authPath) {
      throw new Error(
        `bindingToAdapter: github-copilot binding requires options.copilotAuthPath. ` +
          `Pass the path to your auth.json (typically ~/.agentx/auth.json).`
      );
    }
    return new CopilotChatAdapter({
      authPath,
      model: modelId,
    });
  }

  if (providerId === 'bedrock') {
    // Bedrock adapter (AWS SDK + IAM task role) is the next adapter to land
    // for AWS-deployed harness. Until then, bedrock:* entries skip during
    // resolution unless API-key auth is fully wired through OpenCodeCliAdapter
    // — which it isn't, since opencode doesn't natively know about Bedrock.
    throw new Error(
      `bindingToAdapter: no adapter for bedrock yet — BedrockAdapter is the gap. ` +
        `Remove bedrock:* entries from this agent's accepts list, or implement the adapter.`
    );
  }

  throw new Error(`bindingToAdapter: unhandled provider id "${providerId}"`);
}
