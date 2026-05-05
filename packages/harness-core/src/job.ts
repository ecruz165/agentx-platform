import type { AdapterId } from './catalog.ts';

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RegisteredAgent {
  id: string;
  role: string;
  adapter: AdapterId;
  systemPrompt?: string;
  status: AgentStatus;
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
