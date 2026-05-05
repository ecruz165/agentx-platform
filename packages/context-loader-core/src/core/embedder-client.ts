/**
 * Thin HTTP client for OpenAI-compatible /v1/embeddings endpoints.
 *
 * Used by the loader to vectorize chunks. The default workspace embedder is
 * ai/qwen3-embedding via Docker Model Runner locally and Bedrock Titan v2
 * in deployed envs (both 1024-dim, same OpenAI-compatible shape — see
 * project_embedder_choice memory). This client speaks the OpenAI-compatible
 * protocol so it also works against any compliant endpoint: llama.cpp, TEI,
 * Ollama, vLLM, OpenAI itself, Together, LiteLLM, etc.
 *
 * Phase B.0: minimal viable client. Phase C/D add: retry with backoff, batch
 * size auto-tuning, request-level timeouts, in-flight metrics.
 */

import type { EmbedderConfig } from '../types.ts';

export interface EmbedderClient {
  /** Embed N texts, return N vectors. Order preserved. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embedder dim (matches the configured backend's vector index). */
  readonly dim: number;
}

/**
 * Injected fetch fn — defaults to global fetch but tests pass a mock.
 * Matches the standard fetch signature so tests can use vi.fn() returning
 * a Response.
 */
export type FetchFn = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CreateHttpEmbedderClientOpts {
  config: EmbedderConfig;
  fetch?: FetchFn;
}

/**
 * Create an HTTP embedder client for an OpenAI-compatible /v1/embeddings
 * endpoint.
 */
export function createHttpEmbedderClient(
  opts: CreateHttpEmbedderClientOpts
): EmbedderClient {
  const { config } = opts;
  const fetchFn: FetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const url = config.url.endsWith('/embeddings')
    ? config.url
    : config.url.replace(/\/+$/, '') + '/embeddings';

  // Default batch size 1 because Docker Model Runner's llama.cpp slot
  // scheduler crashes under certain N>1 batch shapes (see bug surfaced
  // in the manual end-to-end smoke). Robust embedders (TEI, Bedrock,
  // OpenAI) should set batchSize to 16-256 for throughput.
  const batchSize = Math.max(1, config.batchSize ?? 1);

  async function callOnce(input: string[]): Promise<Float32Array[]> {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, input }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new EmbedderError(
        `embedder ${url} returned HTTP ${resp.status}: ${body.slice(0, 500)}`
      );
    }
    const json = (await resp.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    if (!json.data || !Array.isArray(json.data) || json.data.length !== input.length) {
      throw new EmbedderError(
        `embedder ${url} returned ${json.data?.length ?? 0} vectors for ${input.length} inputs`
      );
    }
    return json.data.map((d) => {
      if (!Array.isArray(d.embedding)) {
        throw new EmbedderError(`embedder ${url} returned non-array embedding`);
      }
      if (d.embedding.length !== config.dim) {
        throw new EmbedderError(
          `embedder dim mismatch: configured ${config.dim}, got ${d.embedding.length}`
        );
      }
      return Float32Array.from(d.embedding);
    });
  }

  return {
    dim: config.dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      // Single call when the whole input fits in one batch.
      if (texts.length <= batchSize) return callOnce(texts);
      // Otherwise loop. Sequential — concurrent in-flight requests can
      // re-trigger the same multi-slot bug we're working around.
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const batch = await callOnce(slice);
        out.push(...batch);
      }
      return out;
    },
  };
}

export class EmbedderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderError';
  }
}
