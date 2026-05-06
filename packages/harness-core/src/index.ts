/**
 * @agentx/harness-core — orchestration primitives for running pipelines.
 *
 * Cutting principle: only what an in-process consumer (CLI, tests, future
 * IDE extensions) needs to execute a pipeline lives here. Transport (UDS/HTTP),
 * worker spawning, and the coordinator agent stay in @agentx/harness-server.
 */

export {
  loadCatalog,
  findPipeline,
  findProduct,
  validateUnifiedCatalog,
  resolveAccepts,
  CatalogError,
  type Catalog,
  type PipelineCatalog,
  type PipelineDef,
  type ProductDef,
  type ContextSourceDef,
  type AgentDef,
  type AdapterId,
} from './catalog.ts';

export { JobBus, bridgeAdapter, type Envelope } from './job-bus.ts';

export {
  runJob,
  defaultAdapterFactory,
  type AdapterFactory,
  type RunJobDeps,
} from './orchestrator.ts';

export type { AgentStatus, RegisteredAgent, JobRecord } from './job.ts';
