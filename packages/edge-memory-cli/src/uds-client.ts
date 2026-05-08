/**
 * Tiny UDS+JSON client. The CLI's whole job is argv → JSON → UDS →
 * JSON → stdout, so the network code is intentionally minimal: no
 * keep-alive, no pooling, no streaming. One subprocess invocation =
 * one request = one JSON response.
 *
 * Same shape as edge-context-cli's uds-client — kept independent
 * (rather than extracted to a shared package) for cold-start: a
 * shared dep adds resolution cost on every CLI invocation.
 */

import { request } from 'node:http';

export interface UdsResponse<T = unknown> {
  status: number;
  body: T;
}

export class UdsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'UdsRequestError';
  }
}

export interface UdsRequestOptions {
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
}

export function udsJson<T = unknown>(
  socketPath: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  body?: unknown,
  opts: UdsRequestOptions = {},
): Promise<UdsResponse<T>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> =
      body !== undefined ? { 'content-type': 'application/json' } : {};
    const req = request(
      { socketPath, path, method, headers, timeout: opts.timeoutMs ?? 10_000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let parsed: unknown = null;
          if (buf) {
            try {
              parsed = JSON.parse(buf);
            } catch {
              parsed = buf;
            }
          }
          if (status >= 200 && status < 300) {
            resolve({ status, body: parsed as T });
          } else {
            const errMsg =
              parsed && typeof parsed === 'object' && 'error' in parsed
                ? String((parsed as { error: unknown }).error)
                : `HTTP ${status}`;
            reject(new UdsRequestError(errMsg, status, parsed));
          }
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${opts.timeoutMs ?? 10_000}ms`));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
