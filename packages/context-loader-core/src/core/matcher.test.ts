import { describe, expect, it } from 'vitest';
import { compileMatcher } from './matcher.ts';

describe('compileMatcher', () => {
  it('matches simple extension globs', () => {
    const m = compileMatcher({ include: ['**/*.md'] });
    expect(m('README.md')).toBe(true);
    expect(m('docs/guide.md')).toBe(true);
    expect(m('docs/nested/deep/file.md')).toBe(true);
    expect(m('README.txt')).toBe(false);
  });

  it('handles brace alternation', () => {
    const m = compileMatcher({ include: ['**/*.{md,mdx,rst}'] });
    expect(m('a.md')).toBe(true);
    expect(m('b.mdx')).toBe(true);
    expect(m('c.rst')).toBe(true);
    expect(m('d.txt')).toBe(false);
  });

  it('rejects excluded paths', () => {
    const m = compileMatcher({
      include: ['**/*.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    });
    expect(m('src/index.ts')).toBe(true);
    expect(m('node_modules/foo/index.ts')).toBe(false);
    expect(m('packages/x/dist/build.ts')).toBe(false);
  });

  it('accepts everything when include is empty', () => {
    const m = compileMatcher({ exclude: ['**/build/**'] });
    expect(m('any/path.foo')).toBe(true);
    expect(m('build/output.js')).toBe(false);
  });

  it('rejects everything when no patterns and no defaults', () => {
    const m = compileMatcher({ include: ['**/*.specific'] });
    expect(m('whatever.txt')).toBe(false);
    expect(m('a.specific')).toBe(true);
  });

  it('respects path separators (does not let * cross /)', () => {
    const m = compileMatcher({ include: ['*.md'] });
    expect(m('file.md')).toBe(true);
    expect(m('docs/file.md')).toBe(false);
  });

  it('handles complex catalog-style patterns', () => {
    const m = compileMatcher({
      include: ['**/*.{ts,tsx,js,jsx,java,kt,py,go,rs}'],
      exclude: ['**/node_modules/**', '**/__pycache__/**', '**/target/**'],
    });
    expect(m('packages/foo/src/index.ts')).toBe(true);
    expect(m('app-ui/components/Button.tsx')).toBe(true);
    expect(m('app-service/Main.java')).toBe(true);
    expect(m('node_modules/react/index.ts')).toBe(false);
    expect(m('app/__pycache__/x.py')).toBe(false);
    expect(m('build/target/x.kt')).toBe(false);
  });
});
