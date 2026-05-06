/**
 * LLMProvider data model — the registry record for a model provider.
 *
 * Per project memory `project_per_worker_model_subscription`: every model
 * usable from the harness is served by some provider. A provider has two
 * facets:
 *   1. authMethods — how a deployment can authenticate against this provider
 *   2. models      — which models this provider can serve once authenticated
 *
 * Agents declare an `accepts: <provider>:<model>[]` priority list in their
 * catalog spec; the broker walks the list and returns the first satisfiable
 * binding. Resolution lives in a follow-up commit; this file is just the
 * data shapes.
 *
 * v1 registry is hardcoded (provider-registry.ts). Loading from JSON to
 * support custom-hosted endpoints (vLLM etc.) is a future widening that
 * would relax `Provider` from a closed union to `string`.
 */

import type { Provider } from './types.ts';

/**
 * Authentication methods a provider supports. A deployment satisfies a
 * provider iff `authMethods.length === 0` OR at least one of the listed
 * methods matches what's stored in AuthStore / Secrets Manager.
 *
 * - `device-code`   — OAuth 2.0 device flow (today: GitHub Copilot)
 * - `api-key`       — long-lived secret (Anthropic, OpenAI, Google, optional Bedrock)
 * - `iam-task-role` — AWS IAM role attached to the running task (Bedrock default on AWS)
 */
export type AuthMethod = 'device-code' | 'api-key' | 'iam-task-role';

/**
 * The kind of API surface a model implements — different request/response
 * shapes, different adapters.
 *
 * `text` covers chat, single-shot completion, function calling, structured
 * output — anything text-in-text-out. Capabilities like vision/tools sit
 * inside `ModelDescriptor.capabilities`, not here.
 *
 * `multimodal` is reserved for models whose input AND output modalities
 * include non-text (e.g., GPT-4o realtime audio). A vision-capable Claude
 * is `text` with `capabilities: ['vision']` because output is still text.
 */
export type ModelType =
  | 'text'
  | 'text-embedding'
  | 'multimodal'
  | 'rerank'
  | 'transcription'
  | 'image';

export interface ModelDescriptor {
  /** Stable handle used in catalog `accepts` entries. May differ from the
   *  vendor's own model id — e.g., we use "claude-opus-4-7-bedrock" but the
   *  actual Bedrock id is "anthropic.claude-opus-4-7-20251101-v1:0". */
  id: string;
  /** API surface — picks the adapter shape. */
  type: ModelType;
  /** Vendor-side model id passed to the provider's SDK. Optional; resolver
   *  defaults to `id` when our handle matches the vendor's. */
  vendorModelId?: string;
  /** Context window in tokens (text + multimodal). */
  contextWindow?: number;
  /** Within-`text` feature flags: 'tools' | 'vision' | 'thinking' etc. */
  capabilities?: string[];
  /** Vector dimensions (text-embedding only). 1024 for Qwen3 + Bedrock Titan v2. */
  embeddingDim?: number;
  /** Multimodal-specific: which input modalities this model accepts. */
  inputModalities?: string[];
  /** Multimodal-specific: which output modalities this model produces. */
  outputModalities?: string[];
  /** Rough cost class — used by selection policies that prefer cheaper models. */
  costTier?: 'frontier' | 'mid' | 'small';
}

export interface LLMProvider {
  /** Stable id used in catalog accepts (`<id>:<model>`) and AuthStore keys. */
  id: Provider;
  /** Human-friendly name for UX. */
  name: string;
  /** Auth methods supported. Empty array = no auth required (local). */
  authMethods: AuthMethod[];
  /** Models this provider can serve. */
  models: ModelDescriptor[];
}

/**
 * Result of looking up a binding spec against the registry. Used by the
 * broker's `resolveBinding` pipeline to translate accept-list entries
 * into concrete adapter targets.
 *
 * `tool` is set when the binding spec used the explicit 3-part
 * `<tool>:<provider>:<model>` form (per memory `project_three_axis_binding`).
 * For 2-part `<provider>:<model>` bindings, `tool` is undefined and the
 * adapter dispatcher falls back to the default tool for the provider.
 */
export interface ResolvedRegistryEntry {
  tool?: ToolId;
  provider: LLMProvider;
  model: ModelDescriptor;
}

/**
 * Closed set of adapter tooling identifiers, distinct from provider id.
 *
 * Each tool maps to exactly one adapter implementation:
 *   - claude-sdk    → ClaudeSdkAdapter (Anthropic SDK direct)
 *   - openai-api    → OpenAiChatAdapter (OpenAI-compatible chat completions)
 *   - copilot-api   → CopilotChatAdapter (GitHub Copilot's chat endpoint)
 *   - opencode-cli  → OpenCodeCliAdapter (the `opencode` binary)
 *
 * Per memory `project_three_axis_binding`: tools are about HOW we adapt;
 * providers are about WHO authenticates; models are about WHICH capability.
 * One provider can be reachable through multiple tools (e.g., openai via
 * direct API or via opencode); the binding spec carries the tool when
 * the choice matters.
 *
 * Future tools (Bedrock SDK, Gemini direct API, LangChain) get added here
 * as they're implemented; the binding parser sees them via this same union.
 */
export type ToolId =
  | 'claude-sdk'
  | 'openai-api'
  | 'opencode-cli'
  | 'copilot-api';
