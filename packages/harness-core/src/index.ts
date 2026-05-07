/**
 * @ecruz165/harness-core — orchestration primitives for running pipelines.
 *
 * Cutting principle: only what an in-process consumer (CLI, tests, future
 * IDE extensions) needs to execute a pipeline lives here. Transport (UDS/HTTP),
 * worker spawning, and the coordinator agent stay in @ecruz165/harness-server.
 */

export {
  type AdapterId,
  type AgentConfig,
  type AgentDef,
  type ApprovalTag,
  type Assertion,
  type BackoffPolicy,
  type Catalog,
  CatalogError,
  type ConditionalEdge,
  type ContextSourceDef,
  type Duration,
  type Edge,
  type ErrorEdge,
  type Expression,
  type FallbackEdge,
  type FlowCatalog,
  type FlowDef,
  type FlowOutputContract,
  findFlow,
  findProduct,
  type GateConfig,
  type JobIntent,
  type LoopTag,
  loadCatalog,
  type ProductDef,
  type ProductRepo,
  type RejectEdge,
  type RejectionPayload,
  type RetryPolicy,
  resolveAccepts,
  type ScriptConfig,
  type SequenceEdge,
  type SteeringInputSchema,
  type SubflowConfig,
  type SuspendTag,
  type TaskStep,
  type TaskStepPolicy,
  type TaskStepTags,
  type ToolConfig,
  type TransformConfig,
  type TriggerConfig,
  validateUnifiedCatalog,
  walkAgents,
} from './catalog.ts';
export {
  type ApprovalRequest,
  type ApprovalResume,
  buildRouter,
  type CompileFlowOptions,
  compileFlow,
  evalExpression,
  FlowState,
  type FlowStateT,
  linearFlowFromAgents,
  type NodeExecutor,
  type NodeExit,
  type SuspendRequest,
} from './flow-graph.ts';
export type { AgentStatus, AgentTokens, JobRecord, RegisteredAgent } from './job.ts';
export { bridgeAdapter, type Envelope, JobBus } from './job-bus.ts';
export {
  type AdapterFactory,
  type CompiledFlowGraph,
  DEFAULT_FALLBACK_ERRORS,
  defaultAdapterFactory,
  type RunJobDeps,
  resumeJob,
  runJob,
} from './orchestrator.ts';
export { TokenAccumulator } from './token-accumulator.ts';
