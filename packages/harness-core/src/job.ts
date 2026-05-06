import type { AdapterId } from './catalog.ts';

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RegisteredAgent {
  id: string;
  role: string;
  adapter: AdapterId;
  systemPrompt?: string;
  status: AgentStatus;
  /**
   * Adapter-specific config copied from AgentDef.config when the job is
   * registered. Passed through to the adapter factory at invoke time.
   */
  config?: Record<string, unknown>;
  /**
   * Priority-ordered `<provider>:<model>` accept-list copied from
   * AgentDef.accepts when the job is registered. When present, the
   * orchestrator routes through BindingResolver + bindingToAdapter
   * instead of the legacy `adapter` factory dispatch. Optional for
   * backwards compatibility — agents declared without `accepts` fall
   * through to the existing `adapter`-id-based factory.
   */
  accepts?: readonly string[];
}

export interface JobRecord {
  jobId: string;
  pipeline?: string;
  productId?: string;
  productRepos?: string[];
  name?: string;
  input?: string;
  submittedAt: string;
  status: string;
  agents: RegisteredAgent[];
  [key: string]: unknown;
}
