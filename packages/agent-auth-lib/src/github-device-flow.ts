import type { Provider } from './types.ts';

/**
 * GitHub OAuth Device Flow for CLI applications.
 *
 * Public Copilot client_id `Iv1.b507a08c87ecfe98` is the same one used by VS
 * Code's Copilot extension and every OSS Copilot client. For a corporate
 * deployment, register your own GitHub OAuth App and override via the
 * `GITHUB_COPILOT_CLIENT_ID` env var.
 *
 * v1 stores only the GitHub OAuth access token. The Copilot session-token
 * exchange (api.github.com/copilot_internal/v2/token) is deferred to v1.x
 * when a real Copilot adapter ships — the `_internal` URL is undocumented
 * and short-lived, not appropriate for v1 stability commitments.
 */
const DEFAULT_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceFlowResult {
  provider: Provider;
  apiKey: string;
  tokenType: string;
  scope: string;
  expiresAt?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenSuccess {
  access_token: string;
  token_type: string;
  scope: string;
}

interface AccessTokenPending {
  error:
    | 'authorization_pending'
    | 'slow_down'
    | 'expired_token'
    | 'access_denied'
    | 'unsupported_grant_type';
  error_description?: string;
}

type AccessTokenResponse = AccessTokenSuccess | AccessTokenPending;

export interface DeviceFlowOptions {
  clientId?: string;
  scopes?: string[];
  /**
   * Called once with the user-facing prompt. Default: print to stderr.
   * Useful for CLIs that want to render the prompt differently (e.g., open
   * the URL automatically).
   */
  onPrompt?: (info: { verificationUri: string; userCode: string; expiresIn: number }) => void;
}

export async function loginGitHubCopilot(opts: DeviceFlowOptions = {}): Promise<DeviceFlowResult> {
  const clientId =
    opts.clientId ?? process.env.GITHUB_COPILOT_CLIENT_ID ?? DEFAULT_COPILOT_CLIENT_ID;
  const scopes = opts.scopes ?? ['read:user'];

  const code = await requestDeviceCode(clientId, scopes);

  (opts.onPrompt ?? defaultPrompt)({
    verificationUri: code.verification_uri,
    userCode: code.user_code,
    expiresIn: code.expires_in,
  });

  const token = await pollForAccessToken(clientId, code);

  return {
    provider: 'github-copilot',
    apiKey: token.access_token,
    tokenType: token.token_type,
    scope: token.scope,
  };
}

async function requestDeviceCode(clientId: string, scopes: string[]): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: scopes.join(' ') }),
  });
  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForAccessToken(
  clientId: string,
  code: DeviceCodeResponse,
): Promise<AccessTokenSuccess> {
  let intervalMs = code.interval * 1000;
  const deadline = Date.now() + code.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) {
      throw new Error(`Token poll HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as AccessTokenResponse;

    if ('access_token' in body) return body;

    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(
      `Device flow failed: ${body.error}${body.error_description ? ` — ${body.error_description}` : ''}`,
    );
  }

  throw new Error(`Device flow timed out after ${code.expires_in}s without authorization.`);
}

function defaultPrompt(info: {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
}): void {
  process.stderr.write(
    `\n  Open ${info.verificationUri}\n` +
      `  Enter code: ${info.userCode}\n` +
      `  (expires in ${Math.round(info.expiresIn / 60)}m)\n\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
