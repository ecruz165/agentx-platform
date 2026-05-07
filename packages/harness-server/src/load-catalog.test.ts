/**
 * Tests for loadCatalogFromWorkspaceYaml — the catalog loader that
 * stitches together the workspace's YAML/JSON config files.
 *
 * Two halves under test:
 *   - phases → AgentStep translation in flows.json (the workspace's
 *     developer-friendly shape collapses into harness-core's canonical
 *     `nodes`+`edges` graph before the validator runs)
 *   - product harvesting from harness-workspace.yml's per-product
 *     contextSources block
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef, FlowDef } from '@ecruz165/harness-core';
import { describe, expect, it } from 'vitest';
import { loadCatalogFromWorkspaceYaml } from './load-catalog.ts';

/** Test helper: pull the i-th agent out of a flow's nodes when we know
 *  it's an AgentStep node. */
function agentAt(p: FlowDef, i: number): AgentDef {
  // Skip the synthetic __trigger node (always at index 0 for phases-expanded flows).
  const target = p.nodes.filter((n) => n.kind === 'agent')[i];
  if (!target || target.kind !== 'agent') {
    throw new Error(`expected agent node at index ${i}, got ${target?.kind}`);
  }
  return (target.config as { agent: AgentDef }).agent;
}

function withWorkspace(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync('/tmp/agx-cat-test-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('loadCatalogFromWorkspaceYaml — flows (phases shorthand → graph)', () => {
  it('translates the workspace `phases` shape into trigger + agent nodes + sequence edges', async () => {
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          version: 1,
          flows: [
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
        expect(cat.flows).toHaveLength(1);
        const p = cat.flows[0]!;
        expect(p.id).toBe('feature-add');

        // 1 trigger + 2 agents = 3 nodes; trigger→plan, plan→implement = 2 edges
        expect(p.nodes).toHaveLength(3);
        expect(p.edges).toHaveLength(2);
        expect(p.nodes[0]?.kind).toBe('trigger');

        expect(agentAt(p, 0)).toEqual({
          id: 'plan',
          role: 'Senior engineer plans',
          adapter: 'claude-sdk',
          config: {
            model: 'claude-opus-4-7',
            reasoningEffort: 'medium',
            tools: ['memory.query', 'context.query'],
          },
        });
        expect(agentAt(p, 1)).toEqual({
          id: 'implement',
          role: 'Editor agent makes changes',
          adapter: 'opencode-cli',
          config: {
            model: 'anthropic/claude-opus-4-7',
            tools: ['edit', 'bash'],
          },
        });
      },
    );
  });

  it('falls back to phase.id for role when description is absent', async () => {
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          flows: [
            {
              id: 'p',
              phases: [{ id: 'plan', agent: 'claude-sdk' }],
            },
          ],
        }),
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(agentAt(cat.flows[0]!, 0).role).toBe('plan');
      },
    );
  });

  it('accepts the canonical `nodes` + `edges` shape directly', async () => {
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          flows: [
            {
              id: 'native',
              nodes: [
                { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
                {
                  id: 'a1',
                  kind: 'agent',
                  config: {
                    agent: {
                      id: 'a1',
                      role: 'Coordinator',
                      adapter: 'claude-sdk',
                      config: { model: 'claude-opus-4-7' },
                    },
                  },
                },
              ],
              edges: [{ from: '__trigger', to: 'a1', type: 'sequence' }],
            },
          ],
        }),
      },
      async (root) => {
        const cat = await loadCatalogFromWorkspaceYaml(root);
        expect(agentAt(cat.flows[0]!, 0).id).toBe('a1');
        expect(agentAt(cat.flows[0]!, 0).role).toBe('Coordinator');
      },
    );
  });

  it('rejects unknown adapter ids in phase.agent with a clear message', async () => {
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          flows: [
            {
              id: 'bad',
              phases: [{ id: 'p', agent: 'mystery-agent' }],
            },
          ],
        }),
      },
      async (root) => {
        await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(
          /must be "claude-sdk" or "opencode-cli"/,
        );
      },
    );
  });

  it('rejects flows that have neither nodes+edges nor phases', async () => {
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          flows: [{ id: 'empty', description: 'nothing here' }],
        }),
      },
      async (root) => {
        await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(
          /needs either "nodes"\+"edges" or "phases"/,
        );
      },
    );
  });

  it('returns empty flows when flows.json is missing', async () => {
    await withWorkspace({}, async (root) => {
      const cat = await loadCatalogFromWorkspaceYaml(root);
      expect(cat.flows).toEqual([]);
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
      },
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
    // Mirror the actual workspace shape: phases-style flows.json +
    // product contextSources in harness-workspace.yml. Validator runs
    // after the merge; if the translation were lossy or wrong, we'd
    // see CatalogError here.
    await withWorkspace(
      {
        '.harness/config/flows.json': JSON.stringify({
          flows: [
            {
              id: 'feature-add',
              phases: [{ id: 'plan', agent: 'claude-sdk', model: 'claude-opus-4-7' }],
            },
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
        expect(cat.flows).toHaveLength(1);
        expect(cat.products).toHaveLength(1);
      },
    );
  });

  it('surfaces malformed JSON with the file path', async () => {
    await withWorkspace({ '.harness/config/flows.json': '{ not json' }, async (root) => {
      await expect(loadCatalogFromWorkspaceYaml(root)).rejects.toThrow(/flows\.json: invalid JSON/);
    });
  });
});
