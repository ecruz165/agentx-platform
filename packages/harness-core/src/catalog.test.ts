import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CatalogError,
  type FlowCatalog,
  type FlowDef,
  findFlow,
  loadCatalog,
  resolveAccepts,
  validateUnifiedCatalog,
  walkAgents,
} from './catalog.ts';

const tmpWorkspace = () => join(tmpdir(), `agentx-catalog-${randomUUID()}`);

describe('loadCatalog', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const writeCatalog = async (workspaceRoot: string, body: string | object) => {
    const dir = join(workspaceRoot, '.harness', 'config');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'flows.json'),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      'utf8',
    );
  };

  /** Minimal valid flow: trigger → agent. */
  const minimalFlow = (id: string): FlowDef => ({
    id,
    nodes: [
      { id: 't', kind: 'trigger', config: { kind: 'manual' } },
      {
        id: 'a',
        kind: 'agent',
        config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
      },
    ],
    edges: [{ from: 't', to: 'a', type: 'sequence' }],
  });

  it('returns an empty catalog when the file does not exist', async () => {
    const ws = tmpWorkspace();
    created.push(ws);

    const catalog = await loadCatalog(ws);

    expect(catalog.flows).toEqual([]);
  });

  it('parses a valid catalog with one flow', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, { flows: [minimalFlow('feature-add')] });

    const catalog = await loadCatalog(ws);

    expect(catalog.flows).toHaveLength(1);
    expect(catalog.flows[0]?.id).toBe('feature-add');
  });

  it('throws CatalogError on malformed JSON', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, '{ not valid json');

    await expect(loadCatalog(ws)).rejects.toBeInstanceOf(CatalogError);
  });

  it('throws when missing "flows" array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, { wrong: true });

    await expect(loadCatalog(ws)).rejects.toThrow(/missing "flows" array/);
  });

  it('rejects duplicate flow ids', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, { flows: [minimalFlow('p'), minimalFlow('p')] });

    await expect(loadCatalog(ws)).rejects.toThrow(/duplicate flow id "p"/);
  });
});

describe('validateFlow — node + edge structure', () => {
  const wrap = (overrides?: Partial<FlowDef>): unknown => ({
    flows: [
      {
        id: 'f',
        nodes: [
          { id: 't', kind: 'trigger', config: { kind: 'manual' } },
          {
            id: 'a',
            kind: 'agent',
            config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
          },
        ],
        edges: [{ from: 't', to: 'a', type: 'sequence' }],
        ...overrides,
      },
    ],
  });

  it('requires exactly one trigger node (zero rejected)', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
            },
          ],
          edges: [],
        }),
        'test',
      ),
    ).toThrow(/exactly one node must have kind 'trigger'/);
  });

  it('requires exactly one trigger node (two rejected)', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            { id: 't1', kind: 'trigger', config: { kind: 'manual' } },
            { id: 't2', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
            },
          ],
          edges: [
            { from: 't1', to: 'a', type: 'sequence' },
            { from: 't2', to: 'a', type: 'sequence' },
          ],
        }),
        'test',
      ),
    ).toThrow(/exactly one node must have kind 'trigger' \(got 2\)/);
  });

  it('rejects edges referring to unknown nodes', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          edges: [{ from: 't', to: 'nonexistent', type: 'sequence' }],
        }),
        'test',
      ),
    ).toThrow(/references unknown node "nonexistent"/);
  });

  it('rejects multiple error edges from the same source', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            { id: 't', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
            },
            {
              id: 'h1',
              kind: 'agent',
              config: { agent: { id: 'h1a', role: 'H', adapter: 'claude-sdk' } },
            },
            {
              id: 'h2',
              kind: 'agent',
              config: { agent: { id: 'h2a', role: 'H', adapter: 'claude-sdk' } },
            },
          ],
          edges: [
            { from: 't', to: 'a', type: 'sequence' },
            { from: 'a', to: 'h1', type: 'error' },
            { from: 'a', to: 'h2', type: 'error' },
          ],
        }),
        'test',
      ),
    ).toThrow(/at most one 'error' edge allowed per source node/);
  });

  it('rejects reject edges from non-gate, non-approval source', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            { id: 't', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
            },
            {
              id: 'b',
              kind: 'agent',
              config: { agent: { id: 'b1', role: 'B', adapter: 'claude-sdk' } },
            },
          ],
          edges: [
            { from: 't', to: 'a', type: 'sequence' },
            { from: 'a', to: 'b', type: 'reject' },
          ],
        }),
        'test',
      ),
    ).toThrow(/reject edges may only originate from kind:'gate' nodes or Approval-tagged nodes/);
  });

  it('allows reject edges from gate nodes and forms a cycle (retry-with-context)', () => {
    expect(() =>
      validateUnifiedCatalog(
        {
          flows: [
            {
              id: 'f',
              nodes: [
                { id: 't', kind: 'trigger', config: { kind: 'manual' } },
                {
                  id: 'agent',
                  kind: 'agent',
                  config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
                },
                {
                  id: 'gate',
                  kind: 'gate',
                  config: {
                    assertions: [
                      {
                        expression: { kind: 'js', expression: 'ctx.score > 0.8' },
                        message: 'low score',
                      },
                    ],
                  },
                },
              ],
              edges: [
                { from: 't', to: 'agent', type: 'sequence' },
                { from: 'agent', to: 'gate', type: 'sequence' },
                { from: 'gate', to: 'agent', type: 'reject', maxAttempts: 3 },
              ],
            },
          ],
        },
        'test',
      ),
    ).not.toThrow();
  });

  it('rejects cycles on non-reject edges', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            { id: 't', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
            },
            {
              id: 'b',
              kind: 'agent',
              config: { agent: { id: 'b1', role: 'B', adapter: 'claude-sdk' } },
            },
          ],
          edges: [
            { from: 't', to: 'a', type: 'sequence' },
            { from: 'a', to: 'b', type: 'sequence' },
            { from: 'b', to: 'a', type: 'sequence' },
          ],
        }),
        'test',
      ),
    ).toThrow(/cycle detected on non-reject edges/);
  });

  it('rejects "approval" + "suspend" tags on the same node', () => {
    expect(() =>
      validateUnifiedCatalog(
        wrap({
          nodes: [
            { id: 't', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: { agent: { id: 'a1', role: 'A', adapter: 'claude-sdk' } },
              tags: {
                approval: {
                  assigneeRole: 'tech-lead',
                  slaMs: 60000,
                  concurrency: 'pessimistic',
                },
                suspend: { trigger: { kind: 'timer', durationMs: 10000 } },
              },
            },
          ],
          edges: [{ from: 't', to: 'a', type: 'sequence' }],
        }),
        'test',
      ),
    ).toThrow(/approval and suspend tags are mutually exclusive/);
  });

  it('requires job-definition flows to declare output: { kind: "job-intent" }', () => {
    expect(() => validateUnifiedCatalog(wrap({ kind: 'job-definition' }), 'test')).toThrow(
      /kind 'job-definition' requires output\.kind 'job-intent'/,
    );
  });
});

describe('walkAgents', () => {
  it('yields AgentDefs for every kind:"agent" node', () => {
    const flow: FlowDef = {
      id: 'f',
      nodes: [
        { id: 't', kind: 'trigger', config: { kind: 'manual' } },
        {
          id: 'a1',
          kind: 'agent',
          config: { agent: { id: 'a', role: 'A', adapter: 'claude-sdk' } },
        },
        { id: 'tool1', kind: 'tool', config: { toolId: 'fmt' } },
        {
          id: 'a2',
          kind: 'agent',
          config: { agent: { id: 'b', role: 'B', adapter: 'claude-sdk' } },
        },
      ],
      edges: [
        { from: 't', to: 'a1', type: 'sequence' },
        { from: 'a1', to: 'tool1', type: 'sequence' },
        { from: 'tool1', to: 'a2', type: 'sequence' },
      ],
    };

    const ids = [...walkAgents(flow)].map((a) => a.id);
    expect(ids).toEqual(['a', 'b']);
  });
});

describe('resolveAccepts', () => {
  it('returns undefined for agents without accepts', () => {
    expect(
      resolveAccepts({ id: 'a', role: 'A', adapter: 'claude-sdk' }, 'default'),
    ).toBeUndefined();
  });

  it('returns flat array as-is', () => {
    expect(
      resolveAccepts(
        { id: 'a', role: 'A', adapter: 'claude-sdk', accepts: ['anthropic:claude-haiku-4-5'] },
        'default',
      ),
    ).toEqual(['anthropic:claude-haiku-4-5']);
  });

  it('picks the named set when present', () => {
    expect(
      resolveAccepts(
        {
          id: 'a',
          role: 'A',
          adapter: 'claude-sdk',
          accepts: { default: ['anthropic:claude-haiku-4-5'], cheap: ['local-qwen:qwen3'] },
        },
        'cheap',
      ),
    ).toEqual(['local-qwen:qwen3']);
  });

  it('falls back to default when set is missing', () => {
    expect(
      resolveAccepts(
        {
          id: 'a',
          role: 'A',
          adapter: 'claude-sdk',
          accepts: { default: ['anthropic:claude-haiku-4-5'] },
        },
        'frontier',
      ),
    ).toEqual(['anthropic:claude-haiku-4-5']);
  });

  it('throws when set is missing and no default', () => {
    expect(() =>
      resolveAccepts(
        {
          id: 'a',
          role: 'A',
          adapter: 'claude-sdk',
          accepts: { cheap: ['local-qwen:qwen3'] },
        },
        'frontier',
      ),
    ).toThrow(CatalogError);
  });
});

describe('findFlow', () => {
  it('finds a flow by id', () => {
    const cat: FlowCatalog = {
      flows: [
        {
          id: 'a',
          nodes: [
            { id: 't', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'x',
              kind: 'agent',
              config: { agent: { id: 'x', role: 'X', adapter: 'claude-sdk' } },
            },
          ],
          edges: [{ from: 't', to: 'x', type: 'sequence' }],
        },
      ],
    };
    expect(findFlow(cat, 'a')?.id).toBe('a');
    expect(findFlow(cat, 'missing')).toBeUndefined();
  });
});
