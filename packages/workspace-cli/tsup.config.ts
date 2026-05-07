import { defineConfig } from 'tsup';

/**
 * Build config for `@ecruz165/workspace`.
 *
 * Strategy: fat-publish — bundle every workspace dep (`@ecruz165/*`) +
 * small npm deps (commander, yaml) inline so the published artifact
 * has near-zero install-time dependencies. The only external deps are
 * `@opentui/core` and `@opentui/react` because they ship platform-
 * specific native bindings that can't be bundled.
 *
 * Output: `dist/bin.js` — single self-contained ES module with a
 * `#!/usr/bin/env bun` shebang. Bun is required because @opentui/core
 * uses bun-ffi-structs and loads .scm tree-sitter assets that Node ESM
 * cannot handle. ESM is also required because `bin.tsx` uses top-level
 * await (Commander setup + procure() invocation), which CJS doesn't
 * support.
 */
export default defineConfig({
  entry: ['src/bin.tsx'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Bundle everything inline EXCEPT the OpenTUI native-binding packages.
  // Without `noExternal`, tsup defaults to externalizing every dependency.
  noExternal: [/^@ecruz165\//, 'commander', 'yaml'],
  external: [
    '@opentui/core',
    '@opentui/react',
    'react',
    'react-devtools-core',
    // Native binding packages bundled by @opentui/core via optionalDependencies
    /^@opentui\/core-/,
  ],
  shims: true,
  // Source bin.tsx already has `#!/usr/bin/env bun` on line 1; esbuild
  // preserves it through the bundle. No banner option needed (would
  // double the shebang and produce a syntax error).
  clean: true,
  // Source maps disabled for the published artifact — keep tarball small.
  sourcemap: false,
  // Don't generate .d.ts — this is a CLI bin, not a library import target.
  dts: false,
  // Don't minify — readable stack traces matter more than 100KB savings.
  minify: false,
});
