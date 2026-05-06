import type { AuthStore } from './auth-store.ts';

/**
 * Copilot session-token exchange + chat-completions API helpers.
 *
 * Two-step auth model (matches GitHub Copilot's actual flow):
 *   1. Device Flow → GitHub OAuth access token (long-lived, stored in apiKey)
 *   2. apiKey → Copilot session token (short-lived ~30m, cached lazily)
 *
 * Step 2's endpoint (`copilot_internal/v2/token`) is undocumented; identity
 * headers below match what the VS Code Copilot extension sends. If GitHub
 * changes either, real Copilot calls will break — fix-up is to update the
 * constants below; the auth chain itself is unaffected.
 */
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions';
const GITHUB_USER_URL = 'https://api.github.com/user';
const TOKEN_REFRESH_THRESHOLD_S = 5 * 60;

const COPILOT_CLIENT_HEADERS = {
  'User-Agent': 'GithubCopilot/1.155.0',
  'Editor-Version': 'agentx/0.0.0',
  'Editor-Plugin-Version': 'copilot.vim/1.16.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
}

/**
 * Exchange the stored GitHub OAuth token for a short-lived Copilot session
 * token. Caches in the AuthStore with proactive 5-minute refresh.
 */
export async function getCopilotSessionToken(
  store: AuthStore,
  githubToken: string,
): Promise<string> {
  const file = await store.read();
  const existing = file.providers['github-copilot'];
  if (existing?.copilotToken && existing.copilotTokenExpiresAt) {
    const remaining = existing.copilotTokenExpiresAt - Math.floor(Date.now() / 1000);
    if (remaining > TOKEN_REFRESH_THRESHOLD_S) return existing.copilotToken;
  }

  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Authorization: `token ${githubToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `Copilot session-token exchange failed (${res.status}): ${await res.text().catch(() => '')}`,
    );
  }
  const data = (await res.json()) as CopilotTokenResponse;

  await store.setProvider('github-copilot', {
    ...(existing ?? { apiKey: githubToken }),
    apiKey: githubToken,
    copilotToken: data.token,
    copilotTokenExpiresAt: data.expires_at,
  });

  return data.token;
}

/**
 * Call Copilot's chat completions API. Handles session-token caching,
 * 401 retry (revocation / clock skew), and surfaces server errors with body.
 */
export async function callCopilot(
  store: AuthStore,
  messages: ChatMessage[],
  model: string = 'gpt-4o',
): Promise<ChatCompletionResponse> {
  const file = await store.read();
  const cred = file.providers['github-copilot'];
  if (!cred?.apiKey || cred.apiKey.includes('REPLACE_ME')) {
    throw new Error(
      'github-copilot not authenticated. Run: pnpm harness auth login github-copilot',
    );
  }

  let token = await getCopilotSessionToken(store, cred.apiKey);
  let res = await postChat(token, messages, model);

  if (res.status === 401) {
    const fresh = await store.read();
    const entry = fresh.providers['github-copilot'];
    if (entry) {
      entry.copilotToken = undefined;
      entry.copilotTokenExpiresAt = undefined;
      await store.write(fresh);
    }
    token = await getCopilotSessionToken(store, cred.apiKey);
    res = await postChat(token, messages, model);
  }

  if (!res.ok) {
    throw new Error(`Copilot chat failed (${res.status}): ${await res.text().catch(() => '')}`);
  }

  return (await res.json()) as ChatCompletionResponse;
}

async function postChat(token: string, messages: ChatMessage[], model: string): Promise<Response> {
  return fetch(COPILOT_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_CLIENT_HEADERS,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
}

/**
 * Fetch the authenticated user's GitHub username for display in `auth status`.
 * Returns null if the call fails — username is purely cosmetic.
 */
export async function fetchGitHubUsername(githubToken: string): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_USER_URL, {
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}
