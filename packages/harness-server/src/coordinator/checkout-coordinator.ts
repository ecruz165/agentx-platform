/**
 * Checkout coordinator — distills a finished job's transcript into
 * lessons-learned for promotion to the central Context server.
 *
 * Per memory `project_checkout_coordinator` — symmetric with the entry
 * coordinator. harness-server appends it to every pipelined job; owns
 * the harvest + distill + promote + complete lifecycle. Per memory
 * `project_memory_promotes_to_context` — memory is per-job ephemeral
 * scratch; an end-of-job evaluator (THIS coordinator) distills it and
 * writes shared learnings to the central Context server. Promotion is
 * one-way.
 *
 * v1 graph shape — single LLM-call distill node:
 *
 *   START → distill → END
 *
 *     distill takes {jobId, intent, transcript} and produces a free-form
 *     `lessons` string (3-5 bullets per category: went well / didn't go
 *     well / key takeaways).
 *
 * What this v1 does NOT do (deferred to 10e/10f):
 *   - Harvest from edge-memory-server. Caller passes the transcript
 *     pre-assembled. Future: a 'harvest' node that UDS-calls
 *     `harness memory query --jobId <id>` and aggregates the result.
 *   - Promote to edge-context as a `learned` source. Future: a 'promote'
 *     node that POSTs the distilled output to the context-loader.
 *   - Promote to central-context. Future: cross-tier promotion node.
 *   - Confidence/quality gates before promotion. v1 unconditional.
 *
 * Why structured-output is NOT used yet: keeps the graph model-agnostic.
 * Forcing JSON-mode requires LangChain's structured-output bindings
 * which differ across providers. Free-form text + downstream parsing
 * (when promotion lands) is a fine v1 — switching to structured output
 * is one node-config change away when consumers actually need fields.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const SYSTEM_PROMPT =
  'You are a post-job lessons-learned distiller for an agent harness. Given a job ' +
  'transcript, produce a concise post-mortem with three sections: "What went well", ' +
  '"What did not go well", and "Key lessons". Use 3-5 short bullet points per section. ' +
  'Be concrete — reference specific actions, decisions, or failure modes from the ' +
  'transcript. Skip generic platitudes. If a section has nothing to report, say so ' +
  'briefly rather than padding.';

/** State shape of the checkout-coordinator graph. */
const CheckoutCoordinatorState = Annotation.Root({
  jobId: Annotation<string>,
  intent: Annotation<string>,
  /** Free-form transcript: typically a concatenation of agent inputs and
   *  outputs. Caller assembles from JobBus events; format isn't pinned. */
  transcript: Annotation<string>,
  /** Distilled lessons string. Free-form text in v1 (no structured output). */
  lessons: Annotation<string>,
});

/**
 * Build the checkout-coordinator's compiled LangGraph against a given
 * chat model. Returns a compiled graph that takes
 *   { jobId, intent, transcript } and produces { lessons }.
 *
 * The graph is stateless — caller can compile once and invoke many
 * times. No checkpointer wired in v1.
 */
export function buildCheckoutCoordinatorGraph(model: BaseChatModel) {
  const builder = new StateGraph(CheckoutCoordinatorState)
    .addNode('distill', async (state) => {
      const prompt = renderDistillPrompt(state.jobId, state.intent, state.transcript);
      const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);
      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      return { lessons: text };
    })
    .addEdge(START, 'distill')
    .addEdge('distill', END);
  return builder.compile();
}

export interface RunCheckoutCoordinatorArgs {
  jobId: string;
  /** The original user intent that started the job. Helpful context for
   *  the distillation prompt — lets the model assess "did the job
   *  actually accomplish what was asked?" */
  intent: string;
  /** Job transcript. Caller assembles. Empty/short transcripts still
   *  produce a (probably terse) distillation. */
  transcript: string;
  model: BaseChatModel;
}

export interface RunCheckoutCoordinatorResult {
  /** The distilled lessons string. Free-form in v1. Caller may store /
   *  forward to the promotion node when 10e/10f land. */
  lessons: string;
}

export async function runCheckoutCoordinator(
  args: RunCheckoutCoordinatorArgs
): Promise<RunCheckoutCoordinatorResult> {
  const graph = buildCheckoutCoordinatorGraph(args.model);
  const result = await graph.invoke({
    jobId: args.jobId,
    intent: args.intent,
    transcript: args.transcript,
  });
  return { lessons: result.lessons };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function renderDistillPrompt(jobId: string, intent: string, transcript: string): string {
  const t = transcript.trim();
  if (!t) {
    return (
      `Job: ${jobId}\n` +
      `Intent: ${intent}\n\n` +
      `Transcript: (empty — no agent activity to distill)\n\n` +
      `Distill into lessons.`
    );
  }
  return (
    `Job: ${jobId}\n` +
    `Intent: ${intent}\n\n` +
    `Transcript:\n${t}\n\n` +
    `Distill into lessons. Three sections, 3-5 bullets each.`
  );
}
