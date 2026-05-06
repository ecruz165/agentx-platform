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
  const { broker, localEndpoint = defaultLocalEndpointResolver } = options;

  if (binding.kind === 'local') {
    const endpoint = localEndpoint(binding.provider.id);
    if (!endpoint) {
      throw new Error(
        `bindingToAdapter: no endpoint configured for local provider "${binding.provider.id}". ` +
          `Set AGENTX_LOCAL_QWEN_ENDPOINT or pass options.localEndpoint.`
      );
    }
    // OpenCodeCliAdapter local-mode: writes a custom provider into
    // opencode.json pointing at this endpoint, model spec becomes
    // `<providerId>/<modelId>` per the adapter's documented contract.
    return new OpenCodeCliAdapter({
      broker,
      endpoint,
      endpointProviderId: binding.provider.id,
      model: `${binding.provider.id}/${binding.model.id}`,
    });
  }

  // Cloud binding from here on.
  const providerId = binding.provider.id;
  // For Bedrock the registry handle (e.g. claude-haiku-4-5-bedrock) is NOT
  // what the SDK takes — vendorModelId is. For everything else they're the
  // same and vendorModelId is undefined, so fall through to id.
  const modelId = binding.model.vendorModelId ?? binding.model.id;

  if (providerId === 'anthropic') {
    return new ClaudeSdkAdapter({ broker, model: modelId });
  }

  if (providerId === 'openai' || providerId === 'google') {
    return new OpenCodeCliAdapter({
      broker,
      provider: providerId,
      model: modelId,
    });
  }

  if (providerId === 'github-copilot') {
    // Auth flow is fully wired (copilot-api.ts) but no chat adapter exists
    // yet. A thin OpenAI-compatible client pointed at
    // api.githubcopilot.com/chat/completions with the refreshed session
    // token is the gap. Until then, github-copilot:* entries in accepts
    // simply skip during resolution.
    throw new Error(
      `bindingToAdapter: no adapter for github-copilot yet — CopilotChatAdapter is the gap. ` +
        `Remove github-copilot:* entries from this agent's accepts list, or implement the adapter.`
    );
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
