import { request } from 'node:http';

/**
 * Connects to an SSE-over-UDS endpoint and invokes `onEvent` for every
 * `data: <json>\n\n` frame received. Returns a `close()` function that
 * disconnects.
 *
 * Frame parsing is intentionally lenient: heartbeats (`: ...`) and other
 * non-data lines are ignored, and JSON parse failures on a single frame
 * skip that frame rather than tearing down the stream.
 *
 * Lifecycle: the caller owns the connection. Calling `close()` is safe to
 * call multiple times. `onError` is only invoked for transport-level errors
 * before any data has been received successfully — once the stream is
 * established, normal disconnects (including the caller's `close()`) do not
 * fire `onError`.
 */
export function connectSseStream<T = unknown>(
  socketPath: string,
  urlPath: string,
  onEvent: (event: T) => void,
  onError?: (err: Error) => void,
): () => void {
  let buffer = '';
  let closed = false;
  let received = false;

  const req = request({ socketPath, path: urlPath, method: 'GET' }, (res) => {
    if (res.statusCode !== 200) {
      onError?.(new Error(`SSE returned ${res.statusCode} for ${urlPath}`));
      req.destroy();
      return;
    }
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      received = true;
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEvent(JSON.parse(line.slice(6)) as T);
            } catch {
              // Skip malformed frame, keep stream open.
            }
          }
        }
      }
    });
    res.on('error', (err) => {
      if (!closed) onError?.(err);
    });
  });

  req.on('error', (err: NodeJS.ErrnoException) => {
    if (closed) return;
    // Caller-initiated abort surfaces as ECONNRESET after data flowed; ignore.
    if (received && err.code === 'ECONNRESET') return;
    onError?.(err);
  });

  req.end();

  return () => {
    if (closed) return;
    closed = true;
    try {
      req.destroy();
    } catch {
      // ignore
    }
  };
}
