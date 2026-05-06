/**
 * Binding resolver — turns a catalog `accepts: string[]` priority list into
 * a concrete ResolvedBinding the spawn-worker layer can hand to an adapter.
 *
 * Per memory `project_per_worker_model_subscription`, accept-list entries
 * are `<provider>:<model>` pairs. The resolver walks the list in order and
 * returns the first satisfiable binding:
 *   - local providers (authMethods.length === 0) are always satisfied
 *   - cloud providers are satisfied iff getCredential(provider.id) succeeds
 *
 * Errors collect every failure reason and throw at the end if no entry was
 * satisfied — gives operators an actionable list rather than a vague
 * "couldn't resolve."
 *
 * This file deliberately holds NO knowledge of:
 *   - where credentials live (FileBroker / SecretsManagerBroker / etc.) —
 *     callers inject a CredentialBroker
 *   - what the local-model endpoint URL is — that's deployment config the
 *     adapter-selection layer will bind, not the resolver's concern
 *   - which adapter shape implements which binding — slice 5 (binding →
 *     adapter factory) handles that
 */

import type { LLMProvider, ModelDescriptor, ToolId } from './llm-provider.ts';
import { findBinding } from './provider-registry.ts';
import type { Credential, CredentialBroker, Provider } from './types.ts';

/**
 * Result of resolving an accept-list entry. The `kind` field is the
 * discriminator: `cloud` carries a Credential the adapter will pass to its
 * SDK; `local` has no credential because the provider's authMethods is
 * empty.
 *
 * `tool` is set when the original binding spec used the explicit 3-part
 * `<tool>:<provider>:<model>` form (per memory `project_three_axis_binding`).
 * For 2-part shorthands, tool is undefined — the adapter dispatcher falls
 * back to the default tool for the provider.
 */
export type ResolvedBinding =
  | {
      readonly kind: 'cloud';
      readonly tool?: ToolId;
      readonly provider: LLMProvider;
      readonly model: ModelDescriptor;
      readonly credential: Credential;
    }
  | {
      readonly kind: 'local';
      readonly tool?: ToolId;
      readonly provider: LLMProvider;
      readonly model: ModelDescriptor;
    };

/**
 * Public interface for binding resolution. Kept separate from
 * `CredentialBroker` so future brokers can be wrapped uniformly without
 * each broker implementation having to ship its own resolver.
 *
 * `resolveAllBindings` is optional so the orchestrator can keep working
 * with stub resolvers that only implement single-binding resolution
 * (the slice 8 contract). When present, the orchestrator uses it to
 * power slice 13c runtime fallback — invoking each binding in priority
 * order and walking to the next one if the current one throws an
 * `AdapterError`.
 */
export interface BindingResolver {
  resolveBinding(accepts: readonly string[]): Promise<ResolvedBinding>;
  resolveAllBindings?(accepts: readonly string[]): Promise<ResolvedBinding[]>;
}

/**
 * Thrown when no entry in the accept-list is satisfiable. Carries the
 * original accept-list AND a per-entry failure list so the caller can
 * produce a useful diagnostic ("you said you'd accept X, Y, Z; here's why
 * each failed").
 */
export class BindingResolutionError extends Error {
  constructor(
    public readonly accepts: readonly string[],
    public readonly failures: readonly string[],
  ) {
    super(
      `No satisfiable binding for accepts=[${accepts.join(', ')}]:\n` +
        failures.map((f) => `  - ${f}`).join('\n'),
    );
    this.name = 'BindingResolutionError';
  }
}

/**
 * Pure-function resolver — exposed for direct unit testing without having
 * to construct a CredentialBroker stub. Walks accepts in priority order.
 *
 * `getCredentialOrThrow` mirrors `CredentialBroker.getCredential` semantics
 * exactly (returns the Credential or throws). The resolver catches the
 * throw, records the message as a failure reason, and continues to the
 * next entry. This lets the resolver work uniformly with any broker
 * implementation that follows the get-or-throw contract.
 */
export async function resolveBindingFor(
  accepts: readonly string[],
  getCredentialOrThrow: (id: Provider) => Promise<Credential>,
): Promise<ResolvedBinding> {
  const failures: string[] = [];
  for (const entry of accepts) {
    const binding = findBinding(entry);
    if (!binding) {
      failures.push(`${entry}: not in registry`);
      continue;
    }
    const { tool, provider, model } = binding;
    if (provider.authMethods.length === 0) {
      // No auth required — local provider satisfied immediately. The
      // tool field carries through if the spec was 3-part.
      return tool !== undefined
        ? { kind: 'local', tool, provider, model }
        : { kind: 'local', provider, model };
    }
    try {
      const credential = await getCredentialOrThrow(provider.id);
      return tool !== undefined
        ? { kind: 'cloud', tool, provider, model, credential }
        : { kind: 'cloud', provider, model, credential };
    } catch (err) {
      failures.push(`${entry}: ${(err as Error).message}`);
    }
  }
  throw new BindingResolutionError(accepts, failures);
}

/**
 * Pure-function variant of `resolveAllBindings` — returns every accept-list
 * entry that is currently satisfiable, preserving priority order.
 *
 * Contract differs from `resolveBindingFor` in two ways:
 *   1. Never throws when the list is empty / nothing is satisfiable. Returns
 *      `[]`. "Give me everything that works" is a value query; an empty
 *      answer is a valid answer. Callers that need failure-on-empty (e.g.,
 *      the orchestrator at agent-launch time) check `.length === 0`
 *      themselves.
 *   2. Per-entry credential failures are silent, not collected into a
 *      diagnostic list. The fallback consumer doesn't need to know "why"
 *      anthropic was unauthenticated — just that it wasn't, and openai
 *      was. (For pre-flight diagnostics, callers should still use
 *      `resolveBindingFor` which collects failures.)
 *
 * Used by slice 13c runtime fallback: enumerate satisfiable candidates
 * once, walk them in order if upstream errors classify as recoverable.
 */
export async function resolveAllBindingsFor(
  accepts: readonly string[],
  getCredentialOrThrow: (id: Provider) => Promise<Credential>,
): Promise<ResolvedBinding[]> {
  const out: ResolvedBinding[] = [];
  for (const entry of accepts) {
    const binding = findBinding(entry);
    if (!binding) continue;
    const { tool, provider, model } = binding;
    if (provider.authMethods.length === 0) {
      out.push(
        tool !== undefined
          ? { kind: 'local', tool, provider, model }
          : { kind: 'local', provider, model },
      );
      continue;
    }
    try {
      const credential = await getCredentialOrThrow(provider.id);
      out.push(
        tool !== undefined
          ? { kind: 'cloud', tool, provider, model, credential }
          : { kind: 'cloud', provider, model, credential },
      );
    } catch {
      // skip unsatisfiable entry — no diagnostic, see contract above
    }
  }
  return out;
}

/**
 * Default `BindingResolver` implementation that composes any
 * `CredentialBroker`. Use this rather than re-implementing the resolver
 * algorithm per broker — `FileBroker` (local), `SecretsManagerBroker`
 * (AWS), and any future broker variant all get binding resolution for
 * free by being passed to this constructor.
 */
export class DefaultBindingResolver implements BindingResolver {
  constructor(private readonly broker: CredentialBroker) {}

  resolveBinding(accepts: readonly string[]): Promise<ResolvedBinding> {
    return resolveBindingFor(accepts, (id) => this.broker.getCredential(id));
  }

  resolveAllBindings(accepts: readonly string[]): Promise<ResolvedBinding[]> {
    return resolveAllBindingsFor(accepts, (id) => this.broker.getCredential(id));
  }
}
