/**
 * Generates a VS Code multi-root workspace file (`<name>.code-workspace`)
 * mapping the procured repos as folder roots.
 *
 * Layout intent:
 *   1. The project root itself is included so harness-workspace.yml,
 *      .devcontainer/, and .harness/ runtime state are visible alongside
 *      the per-repo source code.
 *   2. Each cloned repo gets its own root for clean per-repo source
 *      control + scoped search.
 *
 * Files.exclude/search.exclude on `.harness/**` keeps job worktrees +
 * captures + bare-cache .git dirs out of search scope (they accumulate
 * fast as jobs run).
 */

import type { RepoSpec } from './types.ts';

export interface CodeWorkspaceContent {
  folders: Array<{ path: string; name: string }>;
  settings: Record<string, unknown>;
  extensions: { recommendations: string[] };
}

export function generateCodeWorkspace(
  productName: string,
  repos: readonly RepoSpec[]
): CodeWorkspaceContent {
  return {
    folders: [
      { path: '.', name: `📦 ${productName} (workspace)` },
      ...repos.map((r) => ({
        path: r.name,
        name: r.name,
      })),
    ],
    settings: {
      'files.exclude': {
        '.harness/wt': true,
        '.harness/captures': true,
        '.harness/repos': true,
      },
      'search.exclude': {
        '.harness': true,
      },
    },
    extensions: {
      recommendations: ['ms-vscode-remote.remote-containers'],
    },
  };
}
