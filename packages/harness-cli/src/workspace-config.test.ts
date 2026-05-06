/**
 * Workspace-config schema tests — focused on the contextSources extension
 * landed in Phase G.5. Other fields are exercised via existing CLI tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProduct, readWorkspaceConfig, WorkspaceConfigError } from './workspace-config.ts';

function withWorkspace(yaml: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync('/tmp/agx-cfg-');
  writeFileSync(join(root, 'harness-workspace.yml'), yaml);
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('workspace-config — contextSources', () => {
  it('parses a product with a contextSources array', async () => {
    await withWorkspace(
      `
workspace:
  id: test-ws
  products:
    - id: p1
      repos: []
      contextSources:
        - type: code-full
          target: ./src
        - type: prose-markdown
          target: ./docs
        - type: oss-code
          target: react@18.2.0
          embedderUrl: http://other-embedder:8080/v1
`,
      async (root) => {
        const cfg = await readWorkspaceConfig(root);
        expect(cfg).not.toBeNull();
        const product = findProduct(cfg!, 'p1');
        expect(product).not.toBeNull();
        expect(product!.contextSources).toHaveLength(3);
        expect(product!.contextSources![0]).toEqual({
          type: 'code-full',
          target: './src',
        });
        expect(product!.contextSources![2]).toEqual({
          type: 'oss-code',
          target: 'react@18.2.0',
          embedderUrl: 'http://other-embedder:8080/v1',
        });
      },
    );
  });

  it('treats contextSources as optional', async () => {
    await withWorkspace(
      `
workspace:
  id: test-ws
  products:
    - id: p-no-sources
      repos: []
`,
      async (root) => {
        const cfg = await readWorkspaceConfig(root);
        const product = findProduct(cfg!, 'p-no-sources');
        expect(product).not.toBeNull();
        expect(product!.contextSources).toBeUndefined();
      },
    );
  });

  it('rejects non-array contextSources', async () => {
    await withWorkspace(
      `
workspace:
  id: test-ws
  products:
    - id: bad
      repos: []
      contextSources: "not-an-array"
`,
      async (root) => {
        await expect(readWorkspaceConfig(root)).rejects.toThrow(WorkspaceConfigError);
      },
    );
  });

  it('rejects entries missing required type/target', async () => {
    await withWorkspace(
      `
workspace:
  id: test-ws
  products:
    - id: bad
      repos: []
      contextSources:
        - type: code-full
`,
      async (root) => {
        await expect(readWorkspaceConfig(root)).rejects.toThrow(/target/);
      },
    );
  });
});
