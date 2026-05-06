/**
 * Minimal glob matcher for source-type include/exclude patterns.
 *
 * Phase B.0: handles the patterns the v1 catalog actually uses
 * (path patterns with double-star, single-star, brace alternation, and
 * standard literal characters). Not a full picomatch / micromatch.
 * If pattern complexity grows, swap in picomatch later — same MatcherFn
 * interface.
 *
 * Supported syntax:
 *   - "**\/"             zero or more leading path segments (so "**\/foo" matches "foo")
 *   - "**"               any number of path segments
 *   - "*"                any chars within a segment (no /)
 *   - "?"                any single char within a segment
 *   - "{a,b,c}"          brace alternation
 *
 * Not supported (yet): regex chars, character classes, negation.
 * Excludes are evaluated as a separate pattern set, not as bang-prefixed
 * patterns inside the include list.
 */

export type MatcherFn = (relativePath: string) => boolean;

export interface MatcherSpec {
  include?: string[];
  exclude?: string[];
}

export function compileMatcher(spec: MatcherSpec): MatcherFn {
  const includeRegexes = (spec.include ?? []).map(globToRegex);
  const excludeRegexes = (spec.exclude ?? []).map(globToRegex);
  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/');
    if (excludeRegexes.some((r) => r.test(normalized))) return false;
    if (includeRegexes.length === 0) return true;
    return includeRegexes.some((r) => r.test(normalized));
  };
}

/**
 * Compile a glob pattern to a RegExp.
 *
 * Strategy:
 *   - Expand brace alternation first (most common case in catalog)
 *   - Substitute glob tokens with unique Private-Use-Area placeholders
 *   - Escape remaining regex meta characters
 *   - Replace placeholders with their regex equivalents
 *   - Anchor with ^ and $
 */
function globToRegex(pattern: string): RegExp {
  const expanded = expandBraces(pattern);
  const alternatives = expanded.map(globAlternativeToPattern);
  return new RegExp(`^(?:${alternatives.join('|')})$`);
}

// Unique Private-Use-Area placeholders. Picked because they cannot appear in
// real glob input and are not regex metacharacters, so they survive the
// regex-meta escape pass below without being modified.
const PH_DOUBLESTAR_SLASH = ''; // "**\/"  → "(?:.*/)?"  (matches zero leading segments)
const PH_DOUBLESTAR = ''; // "**"   → ".*"
const PH_STAR = ''; // "*"    → "[^/]*"
const PH_QMARK = ''; // "?"    → "[^/]"

function globAlternativeToPattern(pattern: string): string {
  // Order matters: capture "**\/" before bare "**", and "**" before "*".
  let p = pattern
    .replace(/\*\*\//g, PH_DOUBLESTAR_SLASH)
    .replace(/\*\*/g, PH_DOUBLESTAR)
    .replace(/\*/g, PH_STAR)
    .replace(/\?/g, PH_QMARK);

  // Escape regex meta characters; placeholders are PUA and unaffected.
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Substitute placeholders for their regex equivalents.
  p = p
    .replaceAll(PH_DOUBLESTAR_SLASH, '(?:.*/)?')
    .replaceAll(PH_DOUBLESTAR, '.*')
    .replaceAll(PH_STAR, '[^/]*')
    .replaceAll(PH_QMARK, '[^/]');

  return p;
}

/**
 * Expand brace alternation. {a,b,c} → ['a', 'b', 'c'].
 * Multiple braces multiply: {a,b}.{x,y} → 4 patterns.
 */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  const options = m[1]!.split(',');
  const out: string[] = [];
  for (const opt of options) {
    for (const tail of expandBraces(after)) {
      out.push(before + opt + tail);
    }
  }
  return out;
}
