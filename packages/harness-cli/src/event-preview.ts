/**
 * Single-line preview of one bus envelope, used in the TUI's events
 * column. Lifted out of jobs-tui.tsx so it can be unit-tested without
 * pulling the OpenTUI renderer (the .tsx module bootstraps a renderer
 * at top level, so importing it from a test triggers TUI startup).
 *
 * Per slice 13d-3: response-kind events that carry `usage` get a
 * compact "[↑X ↓Y]" suffix appended to their text preview, so the
 * chronological events stream shows the same cost story as the
 * per-agent AgentsColumn — different views, same data.
 */

import type { Envelope } from '@ecruz165/harness-core';
import { formatTokens } from './token-format.ts';

export function eventPreview(env: Envelope): string {
  const e = env.event;
  switch (e.kind) {
    case 'request':
      return e.user.replace(/\s+/g, ' ');
    case 'response': {
      const text = e.text.replace(/\s+/g, ' ');
      if (e.usage) {
        const inTok = e.usage.promptTokens ?? 0;
        const outTok = e.usage.completionTokens ?? 0;
        if (inTok > 0 || outTok > 0) {
          return `${text}  [${formatTokens({ in: inTok, out: outTok })}]`;
        }
      }
      return text;
    }
    case 'error':
      return e.message;
    case 'loader-event': {
      const c = e.counts;
      const head =
        `[${e.innerKind}] files=${c.files} chunks=${c.chunks} ` +
        `nodes=${c.nodes} edges=${c.edges} vectors=${c.vectors}` +
        (c.errors > 0 ? ` errors=${c.errors}` : '');
      return e.lastItem ? `${head}  ${e.lastItem}` : head;
    }
  }
}
