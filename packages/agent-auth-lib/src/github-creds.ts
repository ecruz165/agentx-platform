/**
 * GitHub credential resolution for repo operations — push, open-PR, merge.
 *
 * Distinct from the {@link Provider} / {@link Credential} pair (which is
 * about LLM-provider API keys): this is specifically the auth a
 * `publish-*` FlowDef node needs to act on a GitHub repository.
 *
 * Resolution is a **cascade**, not a deployment-mode switch:
 *
 *   1. {@link LocalAmbientGitHubResolver} — the developer's own GitHub
 *      auth (`gh auth token`). If present, operations happen *as the
 *      user*; the controlplane is never contacted.
 *   2. {@link ControlplaneGitHubResolver} — only reached when (1) finds
 *      nothing (bare CI runner, remote ephemeral worker). The
 *      controlplane validated the repo's access at repo-definition time
 *      and mints a short-lived GitHub App installation token on demand.
 *      Operations happen *as the App*.
 *
 * {@link ChainedGitHubResolver} composes the two. `publish-*` node
 * executors take a {@link GitHubCredentialResolver} and don't care which
 * link satisfied the request.
 */

import { spawn } from 'node:child_process';

export interface GitHubRepoRef {
  owner: string;
  name: string;
  /** Clone/remote URL when known — lets the local resolver reason about
   *  SSH vs HTTPS remotes. Optional; resolvers fall back to API-only. */
  remoteUrl?: string;
}

export type GitHubCredentialSource = 'local-gh-cli' | 'controlplane-app';

export interface GitHubCredential {
  /** Bearer token for the GitHub REST API (`POST /repos/.../pulls`,
   *  `PUT /repos/.../pulls/{n}/merge`). Also usable as the password in
   *  an HTTPS `git push` (`x-access-token:<token>@github.com/...`). */
  token: string;
  /** Which link of the chain produced this. */
  source: GitHubCredentialSource;
  /** Expiry when known. App installation tokens last ~1h; a `gh`-issued
   *  user token has no meaningful expiry from our side. */
  expiresAt?: string;
  /** The login this token acts as — a GitHub username for local creds,
   *  the App slug for issued ones. For PR author attribution + audit. */
  actor?: string;
}

export interface GitHubCredentialResolver {
  /**
   * Resolve credentials for operating on `repo`. Returns `null` when this
   * resolver cannot satisfy the request — the chain then tries the next
   * link. Throws only on unexpected failures (not on "I don't have it").
   */
  resolve(repo: GitHubRepoRef): Promise<GitHubCredential | null>;
}

export class GitHubCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubCredentialError';
  }
}

// ---------------------------------------------------------------------------
// Local ambient resolver — `gh auth token`
// ---------------------------------------------------------------------------

export interface LocalAmbientGitHubResolverOptions {
  /** `gh` binary, default resolved on PATH. Tests inject a fixture. */
  ghBin?: string;
}

/**
 * Uses the GitHub CLI's stored credentials. `gh auth token` prints a
 * usable token (OAuth or PAT, whatever the user logged in with); we
 * also probe `gh api user --jq .login` for the actor.
 *
 * Returns `null` when `gh` is missing, not authenticated, or errors —
 * that's the signal for the chain to fall through to the controlplane.
 */
export class LocalAmbientGitHubResolver implements GitHubCredentialResolver {
  private readonly ghBin: string;
  constructor(opts: LocalAmbientGitHubResolverOptions = {}) {
    this.ghBin = opts.ghBin ?? 'gh';
  }

  async resolve(_repo: GitHubRepoRef): Promise<GitHubCredential | null> {
    const tokenRes = await runCapture(this.ghBin, ['auth', 'token']).catch(() => null);
    if (!tokenRes || tokenRes.code !== 0) return null;
    const token = tokenRes.stdout.trim();
    if (!token) return null;

    let actor: string | undefined;
    const userRes = await runCapture(this.ghBin, ['api', 'user', '--jq', '.login']).catch(
      () => null,
    );
    if (userRes && userRes.code === 0) {
      const login = userRes.stdout.trim();
      if (login) actor = login;
    }

    return { token, source: 'local-gh-cli', ...(actor ? { actor } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Controlplane-issued resolver — short-lived GitHub App installation token
// ---------------------------------------------------------------------------

export interface ControlplaneGitHubResolverOptions {
  /** Base URL of the controlplane, e.g. `http://localhost:8080`. When
   *  unset, this resolver is a no-op (returns `null`) — useful for
   *  local-only setups with no controlplane running. */
  controlplaneUrl?: string;
  /** Optional auth header value for the controlplane call itself
   *  (Gate 7 hardening adds this; today it's typically unset locally). */
  authorization?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Asks the controlplane to mint a short-lived GitHub App installation
 * token for the given repo.
 *
 * **Endpoint contract** (controlplane side not yet implemented — built
 * with the deferred controlplane work):
 *
 *   POST {controlplaneUrl}/api/github/installation-token
 *   body: { owner: string, name: string }
 *   200 → { token: string, expiresAt: string, appSlug?: string }
 *   404 → repo not registered / GitHub App not installed on it
 *
 * Returns `null` when `controlplaneUrl` is unset or the controlplane
 * says it can't help (404). Throws on transport / 5xx errors so the
 * caller can distinguish "no creds available anywhere" from "controlplane
 * is down".
 */
export class ControlplaneGitHubResolver implements GitHubCredentialResolver {
  private readonly base?: string;
  private readonly authorization?: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: ControlplaneGitHubResolverOptions = {}) {
    this.base = opts.controlplaneUrl?.replace(/\/$/, '');
    this.authorization = opts.authorization;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async resolve(repo: GitHubRepoRef): Promise<GitHubCredential | null> {
    if (!this.base) return null;
    const res = await this.fetchImpl(`${this.base}/api/github/installation-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authorization ? { Authorization: this.authorization } : {}),
      },
      body: JSON.stringify({ owner: repo.owner, name: repo.name }),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new GitHubCredentialError(
        `controlplane installation-token request failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { token?: string; expiresAt?: string; appSlug?: string };
    if (!body.token) {
      throw new GitHubCredentialError('controlplane returned no token');
    }
    return {
      token: body.token,
      source: 'controlplane-app',
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
      ...(body.appSlug ? { actor: body.appSlug } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/**
 * Tries each resolver in order, returning the first non-null result.
 * Throws {@link GitHubCredentialError} if every link declines.
 */
export class ChainedGitHubResolver implements GitHubCredentialResolver {
  constructor(private readonly links: readonly GitHubCredentialResolver[]) {}

  async resolve(repo: GitHubRepoRef): Promise<GitHubCredential | null> {
    for (const link of this.links) {
      const cred = await link.resolve(repo);
      if (cred) return cred;
    }
    return null;
  }

  /** Like {@link resolve} but throws instead of returning `null` — the
   *  ergonomic call for node executors that genuinely need creds. */
  async require(repo: GitHubRepoRef): Promise<GitHubCredential> {
    const cred = await this.resolve(repo);
    if (!cred) {
      throw new GitHubCredentialError(
        `no GitHub credentials available for ${repo.owner}/${repo.name} — ` +
          `tried: ${this.links.map((l) => l.constructor.name).join(', ')}. ` +
          `Run \`gh auth login\` locally, or configure a controlplane URL.`,
      );
    }
    return cred;
  }
}

/**
 * Default chain: local `gh` first, controlplane fallback. Pass a
 * `controlplaneUrl` to enable the second link; omit it for a
 * local-only setup (the chain then just wraps the `gh` resolver).
 */
export function defaultGitHubResolver(opts: {
  ghBin?: string;
  controlplaneUrl?: string;
  controlplaneAuthorization?: string;
} = {}): ChainedGitHubResolver {
  return new ChainedGitHubResolver([
    new LocalAmbientGitHubResolver({ ...(opts.ghBin ? { ghBin: opts.ghBin } : {}) }),
    new ControlplaneGitHubResolver({
      ...(opts.controlplaneUrl ? { controlplaneUrl: opts.controlplaneUrl } : {}),
      ...(opts.controlplaneAuthorization ? { authorization: opts.controlplaneAuthorization } : {}),
    }),
  ]);
}

// ---------------------------------------------------------------------------

function runCapture(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => resolveP({ stdout, stderr, code: code ?? 0 }));
    child.on('error', rejectP);
  });
}
