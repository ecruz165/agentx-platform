/**
 * SpecBroker — a CredentialBroker that returns Credentials from a static
 * map (the JobSpec's `bindings` map) instead of reading from disk.
 *
 * The harness-pipeline runtime never touches the host's auth.json; all
 * credentials it sees were resolved by harness-server (the assembler) and
 * embedded into spec.json. SpecBroker is the read-only window onto that
 * pre-resolved state.
 *
 * Per memory `project_proxy_per_job_architecture` — the auth boundary is
 * sharp by topology: only harness-server reads auth.json; per-job
 * containers see only the credentials they need for their resolved
 * bindings.
 */

import type { Credential, CredentialBroker, Provider, ResolvedBinding } from '@agentx/agent-auth';

export class SpecBroker implements CredentialBroker {
  /**
   * Build from a JobSpec.bindings map. Indexes by provider id so consumers
   * can call `getCredential(provider)` like any other broker.
   *
   * If multiple bindings name the same provider (e.g., one agent uses
   * `anthropic:claude-haiku-4-5` and another `anthropic:claude-opus-4-7`),
   * the credential is the same — Anthropic auth is provider-scoped, not
   * model-scoped. The first cloud binding's credential wins; subsequent
   * ones with the same provider are ignored. Local-kind bindings
   * contribute nothing (no credential).
   */
  constructor(bindings: Record<string, ResolvedBinding>) {
    this.byProvider = new Map();
    for (const binding of Object.values(bindings)) {
      if (binding.kind !== 'cloud') continue;
      if (this.byProvider.has(binding.provider.id)) continue;
      this.byProvider.set(binding.provider.id, binding.credential);
    }
  }

  private readonly byProvider: Map<Provider, Credential>;

  async getCredential(provider: Provider): Promise<Credential> {
    const cred = this.byProvider.get(provider);
    if (!cred) {
      throw new Error(
        `SpecBroker: no credential for provider "${provider}" in this job's bindings. ` +
          `(Provider must be present in JobSpec.bindings — harness-server did not embed one.)`,
      );
    }
    return cred;
  }
}
