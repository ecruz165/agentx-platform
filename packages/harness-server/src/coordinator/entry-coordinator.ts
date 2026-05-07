/**
 * Entry coordinator — picks which pipeline to dispatch a user intent to.
 *
 * Per memory `project_langgraph_two_scopes`: coordinator workflows are
 * admin-owned (clients can't change them) and live in harness-server.
 * Entry-coord is a routing decision tree: given an intent like "fix the
 * auth bug" + a catalog of available pipelines, pick the most appropriate
 * one. Today's harness skips this entirely (clients pass `pipeline` in
 * the submission body); this graph is the foundation for client-side
 * "submit intent only, server picks pipeline" UX.
 *
 * v1 graph shape — single LLM-call node:
 *
 *   START → pickPipeline → END
 *
 *     pickPipeline asks the model: given intent + pipeline list, which
 *     one fits? Returns the picked id verbatim. Validation against the
 *     catalog is the caller's responsibility (invalid → error / retry /
 *     fallback policy is admin-tier, not graph-tier).
 *
 * Future v1.x graph evolution (out of scope for slice 10b):
 *   - confidence threshold + fallback edge to a "default" pipeline
 *   - HITL pause when confidence is low
 *   - intent classification → pipeline mapping (rather than pipeline list
 *     in the prompt) for catalogs with too many pipelines to enumerate
 *   - retry-with-clarification when the LLM picks a non-existent id
 *
 * Auth/runtime placement: this file imports only LangGraph + LangChain
 * primitives, plus harness-core's Catalog type. The model is injected
 * (any BaseChatModel-shape works); production callers pass a
 * HarnessChatModel built from harness-server's coordinator-scoped
 * binding (long-lived opencode-server in tmux session, per
 * project_pipeline_tmux_topology memory). Tests pass stub models.
 */

import type { Catalog, PipelineDef } from '@ecruz165/harness-core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

/**
 * Compact pipeline summary used as input to the graph — id + optional
 * description. Decoupled from the catalog's full PipelineDef so this
 * graph doesn't depend on the agent-list / accepts machinery.
 */
export interface CoordinatorPipelineSummary {
  id: string;
  description?: string;
}

/** State shape of the entry-coordinator graph. */
const EntryCoordinatorState = Annotation.Root({
  intent: Annotation<string>,
  availablePipelines: Annotation<CoordinatorPipelineSummary[]>,
  /** The pipeline id the model picked. Caller validates against catalog. */
  decision: Annotation<string>,
  /** Raw model response — useful for debugging and observability. */
  reasoning: Annotation<string>,
});

const SYSTEM_PROMPT =
  'You are a pipeline router for an agent harness. Given a user intent and a list of ' +
  'available pipelines, pick the most appropriate pipeline for the intent. Reply with ' +
  'ONLY the pipeline id (no explanation, no markdown, no surrounding text). If no ' +
  'pipeline is appropriate, reply with the literal string "NONE".';

/**
 * Build the entry-coordinator's compiled LangGraph against a given chat
 * model. Returns a compiled graph that takes
 *   { intent, availablePipelines } and produces { decision, reasoning }.
 *
 * The graph is stateless — caller can compile once and invoke many times.
 * No checkpointer wired in v1; coordinator decisions are short-lived.
 */
export function buildEntryCoordinatorGraph(model: BaseChatModel) {
  const builder = new StateGraph(EntryCoordinatorState)
    .addNode('pickPipeline', async (state) => {
      const prompt = renderPickPipelinePrompt(state.intent, state.availablePipelines);
      const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);
      const raw =
        typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const decision = pickPipelineFromResponse(raw, state.availablePipelines);
      return { decision, reasoning: raw };
    })
    .addEdge(START, 'pickPipeline')
    .addEdge('pickPipeline', END);
  return builder.compile();
}

/**
 * Extract the pipeline id from the model's free-form response.
 *
 * Strategy (most→least specific):
 *   1. Scan the response for the LAST occurrence of any known pipeline
 *      id from the available list. Reasoning models like Qwen3-thinking
 *      often state intermediate options before landing on the final
 *      answer, so the *last* mention is most likely to be the conclusion.
 *   2. Look for the literal "NONE" token as a final fallback (the
 *      system prompt instructs the model to say NONE when no pipeline
 *      fits).
 *   3. Fall back to first-non-empty-line — handles obedient models that
 *      reply with just the bare id and nothing else.
 *
 * Exported only for testing — the graph node calls this internally.
 */
export function pickPipelineFromResponse(
  raw: string,
  availablePipelines: CoordinatorPipelineSummary[],
): string {
  // (1) Scan for the LAST known pipeline id mention. Custom-boundary
  //     matching: not preceded or followed by a word-char OR a hyphen.
  //     This treats hyphens as part of the id token (so 'docs' won't
  //     match inside 'docs-update') — necessary because regex `\b`
  //     considers `-` a word boundary.
  let bestId = '';
  let bestPos = -1;
  for (const p of availablePipelines) {
    const re = new RegExp(`(?<![\\w-])${escapeRegExp(p.id)}(?![\\w-])`, 'g');
    for (const match of raw.matchAll(re)) {
      const pos = match.index ?? -1;
      if (pos > bestPos) {
        bestPos = pos;
        bestId = p.id;
      }
    }
  }
  if (bestId) return bestId;

  // (2) Look for "NONE" as the model's explicit no-fit signal.
  if (/\bNONE\b/.test(raw)) return 'NONE';

  // (3) First non-empty line as last-ditch fallback. Won't help with
  //     thinking-style responses but covers the bare-answer case where
  //     the model picked something not in the catalog (typo, hallucination)
  //     — still surfaces the model's choice for caller validation.
  return (
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * High-level helper: given a user intent + the loaded catalog + a chat
 * model, run the coordinator graph and return the picked pipeline id +
 * raw reasoning. The caller validates that `pipelineId` exists in the
 * catalog (graph doesn't validate — keeps that policy at the call site).
 */
export interface RunEntryCoordinatorArgs {
  intent: string;
  catalog: Catalog;
  model: BaseChatModel;
}

export interface RunEntryCoordinatorResult {
  /** The pipeline id the LLM picked. May be "NONE" or an id not in the
   *  catalog — caller is responsible for validating. */
  pipelineId: string;
  /** Raw model output for diagnostics/observability. */
  reasoning: string;
}

export async function runEntryCoordinator(
  args: RunEntryCoordinatorArgs,
): Promise<RunEntryCoordinatorResult> {
  const graph = buildEntryCoordinatorGraph(args.model);
  const availablePipelines = args.catalog.pipelines.map(toSummary);
  const result = await graph.invoke({
    intent: args.intent,
    availablePipelines,
  });
  return {
    pipelineId: result.decision,
    reasoning: result.reasoning,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function toSummary(p: PipelineDef): CoordinatorPipelineSummary {
  return {
    id: p.id,
    ...(p.description ? { description: p.description } : {}),
  };
}

function renderPickPipelinePrompt(intent: string, pipelines: CoordinatorPipelineSummary[]): string {
  if (pipelines.length === 0) {
    return `User intent:\n${intent}\n\nNo pipelines are available. Reply NONE.`;
  }
  const list = pipelines
    .map((p) => `- ${p.id}${p.description ? `: ${p.description}` : ''}`)
    .join('\n');
  return `User intent:\n${intent}\n\nAvailable pipelines:\n${list}\n\nReply with ONLY the pipeline id.`;
}
