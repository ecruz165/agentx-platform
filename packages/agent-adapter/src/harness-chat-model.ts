/**
 * HarnessChatModel — LangChain `BaseChatModel` that delegates to an
 * `AgentAdapter`.
 *
 * Per memory `project_langgraph_two_scopes`: when LangGraph runs inside
 * harness-server (coordinators) or harness-pipeline (sophisticated user
 * agents), graph nodes that need an LLM call should go through the same
 * resolver/adapter chain the rest of the harness uses — so auth is
 * sourced from the broker, model selection respects accept-lists, and
 * adapter events flow into JobBus the same way as for non-graph agents.
 *
 * This wrapper makes the adapter LangChain-shaped: a `SimpleChatModel`
 * subclass that any LangGraph node can `.invoke([HumanMessage(...)])` on.
 * Internally it flattens LangChain's multi-message conversation into the
 * `{system?, user}` shape our adapter contract uses; the response comes
 * back as a string the LangGraph node can store in state.
 *
 * Message flattening rules:
 *   - All SystemMessages join with `\n\n` → `system` field
 *   - HumanMessage / AIMessage / ToolMessage join with role labels
 *     ("User: …", "Assistant: …", "Tool: …") → `user` field
 *   - Single HumanMessage with no labels: just the bare content (cleanest
 *     case — graph nodes that want clean prompts shouldn't pay overhead)
 *
 * What this v1 does NOT do (deferred):
 *   - Streaming (`_streamResponseChunks`). Adapters don't stream today
 *     either; comes when both layers do.
 *   - Tool calls / function calling. SimpleChatModel returns plain text,
 *     so graphs that want tool-use should use a different adapter
 *     binding (one that supports tools natively).
 */

import {
  SimpleChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type {
  BaseMessage,
  MessageContent,
} from '@langchain/core/messages';
import { bindingToAdapter, type BindingToAdapterOptions } from './binding-to-adapter.ts';
import type { CredentialBroker, ResolvedBinding } from '@agentx/agent-auth-lib';
import type { AgentAdapter } from './types.ts';

export interface HarnessChatModelOptions extends BaseChatModelParams {
  /** The AgentAdapter to delegate calls to. Either an already-constructed
   *  adapter (e.g., the same one runJob uses for the agent), OR build one
   *  via `createHarnessChatModel({binding, broker})`. */
  adapter: AgentAdapter;
}

export class HarnessChatModel extends SimpleChatModel {
  private readonly adapter: AgentAdapter;

  constructor(options: HarnessChatModelOptions) {
    super(options);
    this.adapter = options.adapter;
  }

  _llmType(): string {
    return 'harness-chat-model';
  }

  /** SimpleChatModel asks for a string response; we flatten messages,
   *  call adapter.invoke, return the response text. */
  async _call(messages: BaseMessage[]): Promise<string> {
    const { system, user } = flattenMessages(messages);
    return this.adapter.invoke({ system, user });
  }
}

/**
 * Build a HarnessChatModel from a ResolvedBinding by routing through
 * `bindingToAdapter`. Convenience for callers that have a binding (e.g.,
 * harness-server's coordinator setup) and just want a LangChain-shaped
 * model to plug into a graph.
 */
export interface CreateHarnessChatModelOptions {
  binding: ResolvedBinding;
  broker: CredentialBroker;
  localEndpoint?: BindingToAdapterOptions['localEndpoint'];
  opencodeServerUrl?: string;
  /** Path to auth.json, required when binding is `github-copilot`.
   *  Forwarded to bindingToAdapter as `copilotAuthPath`. */
  copilotAuthPath?: string;
}

export function createHarnessChatModel(
  opts: CreateHarnessChatModelOptions
): HarnessChatModel {
  const adapter = bindingToAdapter(opts.binding, {
    broker: opts.broker,
    localEndpoint: opts.localEndpoint,
    ...(opts.opencodeServerUrl ? { opencodeServerUrl: opts.opencodeServerUrl } : {}),
    ...(opts.copilotAuthPath ? { copilotAuthPath: opts.copilotAuthPath } : {}),
  });
  return new HarnessChatModel({ adapter });
}

// ─── helpers ──────────────────────────────────────────────────────────────

interface FlattenedMessages {
  system?: string;
  user: string;
}

/**
 * Flatten a LangChain message array into the AgentAdapter contract's
 * `{system, user}` shape.
 *
 * Single-HumanMessage shortcut: when there's exactly one message and it's
 * a HumanMessage, return its bare content as `user` with no role label.
 * This keeps the common case (graph node calls model with one message)
 * clean — adapters and underlying LLMs see the prompt verbatim, not
 * decorated with "User: ...".
 *
 * Multi-message: SystemMessages join into `system`; everything else joins
 * with role labels into `user` so the LLM can see who said what.
 */
function flattenMessages(messages: BaseMessage[]): FlattenedMessages {
  // Single-HumanMessage shortcut
  if (messages.length === 1 && messages[0]!.getType() === 'human') {
    return { user: stringifyContent(messages[0]!.content) };
  }

  const systems: string[] = [];
  const others: string[] = [];
  for (const msg of messages) {
    const type = msg.getType();
    const content = stringifyContent(msg.content);
    if (type === 'system') {
      systems.push(content);
      continue;
    }
    const label =
      type === 'human' ? 'User' :
      type === 'ai' ? 'Assistant' :
      type === 'tool' ? 'Tool' :
      type === 'function' ? 'Function' :
      type;
    others.push(`${label}: ${content}`);
  }
  return {
    system: systems.length > 0 ? systems.join('\n\n') : undefined,
    user: others.join('\n\n'),
  };
}

/** LangChain MessageContent can be a string or an array of content parts
 *  (text/image/etc.). Adapters take strings, so flatten content-parts
 *  by joining text parts and JSON-stringifying any non-text. */
function stringifyContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  // Array of content parts
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if ('text' in part && typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    })
    .join('\n');
}
