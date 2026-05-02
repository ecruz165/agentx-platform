import { request } from 'node:http';
import { stat } from 'node:fs/promises';

export interface UdsResponse {
  status: number;
  body: unknown;
}

/**
 * v1 trust model: every UDS call validates the socket is mode 0600 before
 * connecting. Mirrors `FileBroker`'s permission gate on `auth.json` —
 * together they form the entire decision-#5 surface.
 */
export async function udsRequest(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<UdsResponse> {
  await assertSecureSocket(socketPath);

  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<UdsResponse>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload).toString(),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data ? safeJson(data) : null,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function assertSecureSocket(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) {
    throw new Error(`UDS socket not found: ${path}. Is the server running?`);
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `Socket ${path} has mode 0${mode.toString(8)}; required 0600 per v1 trust model.`
    );
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
