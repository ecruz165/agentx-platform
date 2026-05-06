/**
 * Pure-function formatters for the TUI's token-usage rendering.
 * Lifted out of `jobs-tui.tsx` so they can be unit-tested without
 * pulling React/OpenTUI into the test runner.
 *
 * Per slice 13d: per-interaction array (in/out per LLM call) is the
 * load-bearing display goal. Cumulative totals are derived; the
 * history is what makes "single bloated turn vs many cheap turns"
 * visible.
 */

import type { AgentTokens } from '@agentx/harness-core';

/**
 * Compact integer formatter. Examples: 1234 → "1.2k", 999 → "999",
 * 12345 → "12k", 1_500_000 → "1.5m". Single-decimal under 10k/10m,
 * rounded above. Used to keep per-row width predictable in
 * narrow-column layouts.
 */
export function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`;
}

/** Format one (in, out) pair as "↑1.2k ↓340". Arrows mirror network-
 *  throughput convention (up = sent, down = received) so the layout
 *  reads naturally to anyone familiar with bandwidth tools. */
export function formatTokens(t: AgentTokens): string {
  return `↑${compactNum(t.in)} ↓${compactNum(t.out)}`;
}

/**
 * Format a per-interaction history list for display under an agent.
 *
 * Renders as many entries as fit in `maxWidth`; if more remain,
 * truncates the last visible slot to "+N" so the user can tell
 * additional history exists. Returns empty string when the input
 * has no entries.
 *
 * Layout per entry: `↑1.2k ↓340` + space separator. The "+N" tail
 * uses ~3-4 chars depending on the count.
 */
export function formatTokenHistory(
  history: readonly AgentTokens[] | undefined,
  maxWidth: number
): string {
  if (!history || history.length === 0) return '';
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < history.length; i++) {
    const piece = formatTokens(history[i]!);
    const sep = parts.length > 0 ? 1 : 0;
    // Reserve "+N" space when more entries follow.
    const reserve = i + 1 < history.length ? 4 : 0;
    if (used + sep + piece.length + reserve > maxWidth) {
      const remaining = history.length - i;
      if (remaining > 0) parts.push(`+${remaining}`);
      break;
    }
    parts.push(piece);
    used += sep + piece.length;
  }
  return parts.join(' ');
}
