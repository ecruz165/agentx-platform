/**
 * Tests for loadCatalogFromWorkspaceYaml — the catalog loader that
 * stitches together the workspace's YAML/JSON config files.
 *
 * Two halves under test:
 *   - phases → agents translation in pipelines.json (the workspace's
 *     user-friendly shape collapses into harness-core's canonical
 *     PipelineDef before the validator runs)
 *   - product harvesting from harness-workspace.yml's per-product
 *     contextSources block
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from '@agentx/harness-core';
import { loadCatalogFromWorkspaceYaml } from './load-catalog.ts';

function withWorkspace(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync('/tmp/agx-cat-test-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('loadCatalogFromWorkspaceYaml — pipelines (phases → agents)', () => {
  it('translates the workspace `phases` shape into canonical agents', async () => {
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          version: 1,
          pipelines: [
            {
              id: 'feature-add',
              description: 'Generic feature add',
              phases: [
                {
                  id: 'plan',
                  agent: 'claude-sdk',
                  model: 'claude-opus-4-7',
                  reasoningEffort: 'medium',
                  description: 'Senior engineer plans',
                  tools: ['memory.query', 'context.query'],
                },
                {
                  id: 'implement',
                  agent: 'opencode-cli',
                  model: 'anthropic/claude-opus-4-7',
                  description: 'Editor agent makes changes',
                  tools: ['edit', 'bash'],
                },
              ],
            },
          ],
        }),
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(cat.pipelines).toHaveLength(1);
        const p = cat.pipelines[0]!;
        expect(p.id).toBe('feature-add');
        expect(p.agents).toHaveLength(2);
        expect(p.agents[0]).toEqual({
          id: 'plan',
          role: 'Senior engineer plans',
          adapter: 'claude-sdk',
          config: {
            model: 'claude-opus-4-7',
            reasoningEffort: 'medium',
            tools: ['memory.query', 'context.query'],
          },
        });
        expect(p.agents[1]).toEqual({
          id: 'implement',
          role: 'Editor agent makes changes',
          adapter: 'opencode-cli',
          config: {
            model: 'anthropic/claude-opus-4-7',
            tools: ['edit', 'bash'],
          },
        });
      }
    );
  });

  it('falls back to phase.id for role when description is absent', async () => {
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          pipelines: [
            {
              id: 'p',
              phases: [{ id: 'plan', agent: 'claude-sdk' }],
            },
          ],
        }),
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(cat.pipelines[0]!.agents[0]!.role).toBe('plan');
      }
    );
  });

  it('accepts the canonical `agents` shape directly', async () => {
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          pipelines: [
            {
              id: 'native',
              agents: [
                {
                  id: 'a1',
                  role: 'Coordinator',
                  adapter: 'claude-sdk',
                  config: { model: 'claude-opus-4-7' },
                },
              ],
            },
          ],
        }),
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(cat.pipelines[0]!.agents[0]!.id).toBe('a1');
        expect(cat.pipelines[0]!.agents[0]!.role).toBe('Coordinator');
      }
    );
  });

  it('rejects unknown adapter ids in phase.agent with a clear message', async () => {
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          pipelines: [
            {
              id: 'bad',
              phases: [{ id: 'p', agent: 'mystery-agent' }],
            },
          ],
        }),
      },
      async (root) => {
        await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(
          /must be "claude-sdk" or "opencode-cli"/
        );
      }
    );
  });

  it('rejects pipelines that have neither agents nor phases', async () => {
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          pipelines: [{ id: 'empty', description: 'nothing here' }],
        }),
      },
      async (root) => {
        await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(
          /needs either "agents" or "phases"/
        );
      }
    );
  });

  it('returns empty pipelines when pipelines.json is missing', async () => {
    await withWorkspace({}, async (root) => {
      const cat = await loadCatalogFromWorkspaceYaml(root);
      expect(cat.pipelines).toEqual([]);
    });
  });
});

describe('loadCatalogFromWorkspaceYaml — products from harness-workspace.yml', () => {
  it('reads per-product contextSources into the catalog', async () => {
    await withWorkspace(
      {
        'harness-workspace.yml': `
workspace:
  id: ws
  products:
    - id: p1
      description: "Test product"
      contextSources:
        - type: code-full
          target: ./src
        - type: prose-markdown
          target: ./docs
    - id: p2
      description: "Empty product"
`,
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(cat.products).toHaveLength(2);
        expect(cat.products![0]!.id).toBe('p1');
        expect(cat.products![0]!.contextSources).toHaveLength(2);
        expect(cat.products![1]!.contextSources).toBeUndefined();
      }
    );
  });

  it('emits empty products when no harness-workspace.yml present', async () => {
    await withWorkspace({}, async (root) => {
      const cat = await loadCatalogFromWorkspaceYaml(root);
      expect(cat.products).toEqual([]);
    });
  });
});

describe('loadCatalogFromWorkspaceYaml — combined', () => {
  it('produces a Catalog that passes the unified validator', async () => {
    // Mirror the actual workspace shape: phases-style pipelines.json +
    // product contextSources in harness-workspace.yml. Validator runs
    // after the merge; if the translation were lossy or wrong, we'd
    // see CatalogError here.
    await withWorkspace(
      {
        '.harness/config/pipelines.json': JSON.stringify({
          pipelines: [
            { id: 'feature-add', phases: [{ id: 'plan', agent: 'claude-sdk', model: 'claude-opus-4-7' }] },
          ],
        }),
        'harness-workspace.yml': `
workspace:
  id: ws
  products:
    - id: p1
      contextSources:
        - type: code-full
          target: ./src
`,
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(cat.pipelines).toHaveLength(1);
        expect(cat.products).toHaveLength(1);
      }
    );
  });

  it('surfaces malformed JSON with the file path', async () => {
    await withWorkspace(
      { '.harness/config/pipelines.json': '{ not json' },
      async (root) => {
        await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(
          /pipelines\.json: invalid JSON/
        );
      }
    );
  });
});
