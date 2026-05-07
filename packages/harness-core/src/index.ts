/**
 * @ecruz165/harness-core — orchestration primitives for running pipelines.
 *
 * Cutting principle: only what an in-process consumer (CLI, tests, future
 * IDE extensions) needs to execute a pipeline lives here. Transport (UDS/HTTP),
 * worker spawning, and the coordinator agent stay in @ecruz165/harness-server.
 */

export {
  type AdapterId,
  type AgentDef,
  type Catalog,
  CatalogError,
  type ContextSourceDef,
  findPipeline,
  findProduct,
  loadCatalog,
  type PipelineCatalog,
  type PipelineDef,
  type ProductDef,
  type ProductRepo,
  resolveAccepts,
  validateUnifiedCatalog,
} from './catalog.ts';
export type { AgentStatus, AgentTokens, JobRecord, RegisteredAgent } from './job.ts';
export { bridgeAdapter, type Envelope, JobBus } from './job-bus.ts';
export {
  type AdapterFactory,
  DEFAULT_FALLBACK_ERRORS,
  defaultAdapterFactory,
  type RunJobDeps,
  runJob,
} from './orchestrator.ts';
export { TokenAccumulator } from './token-accumulator.ts';
