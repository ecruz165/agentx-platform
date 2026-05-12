/**
 * Tests for the GitHub credential resolver chain.
 *
 * Focus is the cascade logic in {@link ChainedGitHubResolver} — the
 * shell-out resolvers (`gh auth token`, controlplane HTTP) are exercised
 * via fakes injected through their options, not by spawning real
 * processes or hitting a real controlplane.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ChainedGitHubResolver,
  ControlplaneGitHubResolver,
  type GitHubCredential,
  GitHubCredentialError,
  type GitHubCredentialResolver,
  type GitHubRepoRef,
} from './github-creds.ts';

const REPO: GitHubRepoRef = { owner: 'acme', name: 'widgets' };

function fixedResolver(cred: GitHubCredential | null): GitHubCredentialResolver {
  return { resolve: async () => cred };
}

describe('ChainedGitHubResolver', () => {
  it('returns the first non-null link result', async () => {
    const chain = new ChainedGitHubResolver([
      fixedResolver(null),
      fixedResolver({ token: 'tok-2', source: 'local-gh-cli' }),
      fixedResolver({ token: 'tok-3', source: 'controlplane-app' }),
    ]);
    const cred = await chain.resolve(REPO);
    expect(cred).toEqual({ token: 'tok-2', source: 'local-gh-cli' });
  });

  it('returns null when every link declines', async () => {
    const chain = new ChainedGitHubResolver([fixedResolver(null), fixedResolver(null)]);
    expect(await chain.resolve(REPO)).toBeNull();
  });

  it('require() throws a helpful error when nothing satisfies', async () => {
    const chain = new ChainedGitHubResolver([fixedResolver(null)]);
    await expect(chain.require(REPO)).rejects.toThrow(GitHubCredentialError);
    await expect(chain.require(REPO)).rejects.toThrow(/acme\/widgets/);
  });

  it('does not consult later links once one succeeds', async () => {
    const later = vi.fn<GitHubCredentialResolver['resolve']>(async () => null);
    const chain = new ChainedGitHubResolver([
      fixedResolver({ token: 'tok-1', source: 'local-gh-cli' }),
      { resolve: later },
    ]);
    await chain.resolve(REPO);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('ControlplaneGitHubResolver', () => {
  it('is a no-op (returns null) when no controlplaneUrl is configured', async () => {
    const r = new ControlplaneGitHubResolver({});
    expect(await r.resolve(REPO)).toBeNull();
  });

  it('returns null on 404 (repo not registered / App not installed)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const r = new ControlplaneGitHubResolver({ controlplaneUrl: 'http://cp', fetchImpl });
    expect(await r.resolve(REPO)).toBeNull();
  });

  it('maps a 200 response into a GitHubCredential', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'ghs_xxx', expiresAt: '2026-05-11T12:00:00Z', appSlug: 'agentx-bot' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const r = new ControlplaneGitHubResolver({ controlplaneUrl: 'http://cp/', fetchImpl });
    const cred = await r.resolve(REPO);
    expect(cred).toEqual({
      token: 'ghs_xxx',
      source: 'controlplane-app',
      expiresAt: '2026-05-11T12:00:00Z',
      actor: 'agentx-bot',
    });
  });

  it('throws on 5xx so the chain can distinguish "down" from "declined"', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const r = new ControlplaneGitHubResolver({ controlplaneUrl: 'http://cp', fetchImpl });
    await expect(r.resolve(REPO)).rejects.toThrow(GitHubCredentialError);
  });
});
