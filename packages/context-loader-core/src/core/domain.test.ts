import { describe, expect, it } from 'vitest';
import { classifyDomain, DOMAINS } from './domain.ts';

describe('classifyDomain — deterministic path/source-type rules', () => {
  it.each([
    ['src/auth/login.ts', 'code-full', 'security'],
    ['internal/oauth/token.ts', 'code-full', 'security'],
    ['tests/auth.test.ts', 'code-full', 'testing'], // testing beats security (order)
    ['src/__tests__/foo.ts', 'code-full', 'testing'],
    ['src/components/Button.tsx', 'code-full', 'ui'],
    ['src/api/users.ts', 'code-full', 'api'],
    ['src/routes/index.ts', 'code-full', 'api'],
    ['src/models/User.ts', 'code-full', 'data'],
    ['db/migrations/001.sql', 'code-full', 'data'],
    ['package.json', 'code-full', 'config'],
    ['vite.config.ts', 'code-full', 'config'], // config beats build for *.config.*
    ['scripts/release.ts', 'code-full', 'build'],
    ['infra/main.tf', 'code-full', 'infra'],
    ['Dockerfile', 'code-full', 'infra'],
    ['docs/guide.md', 'prose-markdown', 'docs'],
    ['README.md', 'oss-docs', 'docs'],
  ])('%s (%s) → %s', (path, sourceType, expected) => {
    expect(classifyDomain(path, sourceType)).toBe(expected);
  });

  it('falls back to code for unmatched source files', () => {
    expect(classifyDomain('src/lib/util.ts', 'code-full')).toBe('code');
    expect(classifyDomain('src/lib/util.ts', 'oss-code')).toBe('code');
  });

  it('falls back to other for unknown source types with no path signal', () => {
    expect(classifyDomain('some/opaque/blob', 'totally-unknown')).toBe('other');
  });

  it('always returns a known domain', () => {
    for (const p of ['x', 'a/b/c.ts', '', 'WeIrD/Path.TXT']) {
      expect(DOMAINS).toContain(classifyDomain(p, 'code-full'));
    }
  });

  it('normalizes backslash paths', () => {
    expect(classifyDomain('src\\auth\\login.ts', 'code-full')).toBe('security');
  });
});
