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

import type { CredentialBroker, ResolvedBinding, ToolId } from '@ecruz165/agent-auth';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.ts';
import { CopilotChatAdapter } from './copilot-chat-adapter.ts';
import { OpenAiChatAdapter } from './openai-chat-adapter.ts';
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
  // Explicit tool wins: only opencode-cli needs the server.
  if (binding.tool !== undefined) {
    return binding.tool === 'opencode-cli';
  }
  // 2-part shorthand → infer from provider's default tool.
  if (binding.kind === 'local') return true;
  // Cloud defaults: anthropic→claude-sdk, openai→openai-api,
  // github-copilot→copilot-api, google→opencode-cli, bedrock→(none).
  // Only google's default is opencode-cli among cloud providers.
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
  options: BindingToAdapterOptions,
): AgentAdapter {
  // Explicit-tool dispatch wins when the binding spec was 3-part. Per
  // memory `project_three_axis_binding`: tool is the axis distinct from
  // provider+model; this branch lets catalogs say "use openai via
  // opencode-cli" rather than getting the provider-default route.
  if (binding.tool !== undefined) {
    return dispatchByTool(binding.tool, binding, options);
  }
  // 2-part shorthand → fall back to provider-default dispatch (today's
  // behavior). This is what most catalogs use and continues to work
  // unchanged.
  return dispatchByProviderDefault(binding, options);
}

/**
 * Dispatch when the binding spec named a tool explicitly. Validates the
 * (tool, provider) combination — not every tool can adapt every provider.
 * For example, claude-sdk only works with anthropic; copilot-api only
 * with github-copilot; opencode-cli works with anthropic/openai/google
 * /local but NOT github-copilot or bedrock.
 */
function dispatchByTool(
  tool: ToolId,
  binding: ResolvedBinding,
  options: BindingToAdapterOptions,
): AgentAdapter {
  const providerId = binding.provider.id;
  const modelId = binding.model.vendorModelId ?? binding.model.id;
  const { broker, localEndpoint = defaultLocalEndpointResolver, opencodeServerUrl } = options;

  switch (tool) {
    case 'claude-sdk':
      if (providerId !== 'anthropic') {
        throw new Error(
          `bindingToAdapter: tool=claude-sdk requires provider=anthropic, got ${providerId}`,
        );
      }
      return new ClaudeSdkAdapter({ broker, model: modelId });

    case 'openai-api':
      // OpenAI's chat-completions API is OpenAI-compatible — works for
      // direct OpenAI today. Future: extend to other OpenAI-compatible
      // endpoints (Azure-OpenAI, OpenRouter, etc.) by relaxing this check.
      if (providerId !== 'openai') {
        throw new Error(
          `bindingToAdapter: tool=openai-api requires provider=openai, got ${providerId}`,
        );
      }
      return new OpenAiChatAdapter({ broker, model: modelId });

    case 'copilot-api': {
      if (providerId !== 'github-copilot') {
        throw new Error(
          `bindingToAdapter: tool=copilot-api requires provider=github-copilot, got ${providerId}`,
        );
      }
      const authPath = options.copilotAuthPath;
      if (!authPath) {
        throw new Error(`bindingToAdapter: copilot-api binding requires options.copilotAuthPath`);
      }
      return new CopilotChatAdapter({ authPath, model: modelId });
    }

    case 'opencode-cli':
      // opencode-cli is the multi-provider tool: anthropic, openai,
      // google natively (cloud-mode); local-* via the endpoint mode.
      // github-copilot and bedrock are not natively routable — flag.
      if (providerId === 'github-copilot' || providerId === 'bedrock') {
        throw new Error(
          `bindingToAdapter: tool=opencode-cli does not support provider=${providerId} ` +
            `(opencode 1.4 has no native ${providerId} routing). ` +
            `Use the provider's dedicated tool instead.`,
        );
      }
      if (binding.kind === 'local') {
        const endpoint = localEndpoint(providerId);
        if (!endpoint) {
          throw new Error(
            `bindingToAdapter: no endpoint configured for local provider "${providerId}". ` +
              `Set AGENTX_LOCAL_QWEN_ENDPOINT or pass options.localEndpoint.`,
          );
        }
        const localModelId = binding.model.vendorModelId ?? binding.model.id;
        return new OpenCodeCliAdapter({
          broker,
          endpoint,
          endpointProviderId: providerId,
          model: `${providerId}/${localModelId}`,
          ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
        });
      }
      return new OpenCodeCliAdapter({
        broker,
        provider: providerId,
        model: `${providerId}/${modelId}`,
        ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
      });

    default: {
      // TS exhaustiveness check — adding a new ToolId without updating
      // this switch produces a compile error.
      const _exhaustive: never = tool;
      throw new Error(`bindingToAdapter: unhandled tool "${String(_exhaustive)}"`);
    }
  }
}

/**
 * Dispatch when the binding spec didn't name a tool (2-part shorthand).
 * Picks the default tool for each provider — same routing the
 * pre-three-axis-refactor code did. New code paths should prefer
 * explicit 3-part bindings; this is the back-compat surface.
 */
function dispatchByProviderDefault(
  binding: ResolvedBinding,
  options: BindingToAdapterOptions,
): AgentAdapter {
  const { broker, localEndpoint = defaultLocalEndpointResolver, opencodeServerUrl } = options;

  if (binding.kind === 'local') {
    // Default for any local-* provider: opencode-cli with endpoint mode.
    const endpoint = localEndpoint(binding.provider.id);
    if (!endpoint) {
      throw new Error(
        `bindingToAdapter: no endpoint configured for local provider "${binding.provider.id}". ` +
          `Set AGENTX_LOCAL_QWEN_ENDPOINT or pass options.localEndpoint.`,
      );
    }
    const localModelId = binding.model.vendorModelId ?? binding.model.id;
    return new OpenCodeCliAdapter({
      broker,
      endpoint,
      endpointProviderId: binding.provider.id,
      model: `${binding.provider.id}/${localModelId}`,
      ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
    });
  }

  const providerId = binding.provider.id;
  const modelId = binding.model.vendorModelId ?? binding.model.id;

  // Default tools per provider:
  //   anthropic       → claude-sdk
  //   openai          → openai-api  (direct API; opencode-cli also valid via 3-part)
  //   github-copilot  → copilot-api
  //   google          → opencode-cli (no direct Gemini adapter yet)
  //   bedrock         → (no adapter yet — throws)
  if (providerId === 'anthropic') {
    return new ClaudeSdkAdapter({ broker, model: modelId });
  }
  if (providerId === 'openai') {
    return new OpenAiChatAdapter({ broker, model: modelId });
  }
  if (providerId === 'github-copilot') {
    const authPath = options.copilotAuthPath;
    if (!authPath) {
      throw new Error(
        `bindingToAdapter: github-copilot binding requires options.copilotAuthPath. ` +
          `Pass the path to your auth.json (typically ~/.agentx/auth.json).`,
      );
    }
    return new CopilotChatAdapter({ authPath, model: modelId });
  }
  if (providerId === 'google') {
    return new OpenCodeCliAdapter({
      broker,
      provider: providerId,
      model: `${providerId}/${modelId}`,
      ...(opencodeServerUrl ? { serverUrl: opencodeServerUrl } : {}),
    });
  }
  if (providerId === 'bedrock') {
    throw new Error(
      `bindingToAdapter: no adapter for bedrock yet — BedrockAdapter is the gap. ` +
        `Remove bedrock:* entries from this agent's accepts list, or implement the adapter.`,
    );
  }
  throw new Error(`bindingToAdapter: unhandled provider id "${providerId}"`);
}
