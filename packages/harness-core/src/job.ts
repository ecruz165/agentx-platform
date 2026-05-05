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
