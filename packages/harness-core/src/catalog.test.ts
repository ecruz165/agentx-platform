import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentDef,
  CatalogError,
  findPipeline,
  loadCatalog,
  type PipelineCatalog,
  resolveAccepts,
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
      join(dir, 'pipelines.json'),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      'utf8',
    );
  };

  it('returns an empty catalog when the file does not exist', async () => {
    const ws = tmpWorkspace();
    created.push(ws);

    const catalog = await loadCatalog(ws);

    expect(catalog.pipelines).toEqual([]);
  });

  it('parses a valid catalog', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'feature-add',
          description: 'plan, build, review',
          agents: [
            { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'plan things' },
            { id: 'reviewer', role: 'Review', adapter: 'claude-sdk' },
          ],
        },
      ],
    });

    const catalog = await loadCatalog(ws);

    expect(catalog.pipelines).toHaveLength(1);
    expect(catalog.pipelines[0]?.id).toBe('feature-add');
    expect(catalog.pipelines[0]?.agents.map((a) => a.id)).toEqual(['planner', 'reviewer']);
  });

  it('throws CatalogError on malformed JSON', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, '{ not valid json');

    await expect(loadCatalog(ws)).rejects.toBeInstanceOf(CatalogError);
  });

  it('throws CatalogError when top-level is missing pipelines array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, { wrong: true });

    await expect(loadCatalog(ws)).rejects.toThrow(/missing "pipelines" array/);
  });

  it('throws on duplicate pipeline ids', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        { id: 'p', agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk' }] },
        { id: 'p', agents: [{ id: 'b', role: 'B', adapter: 'claude-sdk' }] },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/duplicate pipeline id "p"/);
  });

  it('throws on duplicate agent ids within a pipeline', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            { id: 'a', role: 'A', adapter: 'claude-sdk' },
            { id: 'a', role: 'A2', adapter: 'claude-sdk' },
          ],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/duplicate agent id "a"/);
  });

  it('throws on unknown adapter id', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [{ id: 'p', agents: [{ id: 'a', role: 'A', adapter: 'gpt-direct' }] }],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/adapter must be "claude-sdk" or "opencode-cli"/);
  });

  it('throws on empty agents array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, { pipelines: [{ id: 'p', agents: [] }] });

    await expect(loadCatalog(ws)).rejects.toThrow(/non-empty array/);
  });

  it('parses an agent with an accepts list (provider:model pairs)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            {
              id: 'planner',
              role: 'Plan',
              adapter: 'claude-sdk',
              accepts: ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3'],
            },
          ],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.accepts).toEqual([
      'anthropic:claude-haiku-4-5',
      'local-qwen:qwen3',
    ]);
  });

  it('parses an agent without an accepts list (backwards-compatible)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk' }],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.accepts).toBeUndefined();
  });

  it('throws when accepts is not an array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            { id: 'a', role: 'A', adapter: 'claude-sdk', accepts: 'anthropic:claude-haiku-4-5' },
          ],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/accepts must be an array/);
  });

  it('throws when an accepts entry is not a string', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: [42] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/must be a non-empty string/);
  });

  it('throws when an accepts entry has no colon', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: ['anthropic'] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/must be of the form "<provider>:<model>"/);
  });

  it('throws when an accepts entry has empty model id ("anthropic:")', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: ['anthropic:'] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/must be of the form "<provider>:<model>"/);
  });

  it('throws when an accepts entry has empty provider id (":model")', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: [':claude-haiku-4-5'] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/must be of the form "<provider>:<model>"/);
  });
});

describe('loadCatalog — fallbackOn (slice 13c per-agent policy)', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const writeCatalog = async (workspaceRoot: string, body: object) => {
    const dir = join(workspaceRoot, '.harness', 'config');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pipelines.json'), JSON.stringify(body, null, 2), 'utf8');
  };

  it('parses a valid fallbackOn list', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            {
              id: 'a',
              role: 'A',
              adapter: 'claude-sdk',
              fallbackOn: ['BillingError', 'RateLimitError'],
            },
          ],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.fallbackOn).toEqual(['BillingError', 'RateLimitError']);
  });

  it('parses an empty fallbackOn list (explicit opt-out)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', fallbackOn: [] }],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.fallbackOn).toEqual([]);
  });

  it('parses agent without fallbackOn (uses default)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk' }],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.fallbackOn).toBeUndefined();
  });

  it('throws when fallbackOn is not an array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', fallbackOn: 'BillingError' }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(
      /must be an array of AdapterError subclass names/,
    );
  });

  it('throws on unknown error class name (closed validation set)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', fallbackOn: ['MysteryError'] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/not a known AdapterError subclass/);
  });

  it('accepts AdapterError as wildcard', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', fallbackOn: ['AdapterError'] }],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.fallbackOn).toEqual(['AdapterError']);
  });

  it('throws on empty string entry', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', fallbackOn: [''] }],
        },
      ],
    });

    await expect(loadCatalog(ws)).rejects.toThrow(/must be a non-empty string/);
  });
});

describe('loadCatalog — skillz (skillzkit catalog references)', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const writeCatalog = async (workspaceRoot: string, body: object) => {
    const dir = join(workspaceRoot, '.harness', 'config');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pipelines.json'), JSON.stringify(body, null, 2), 'utf8');
  };

  const baseAgent = (extra: Record<string, unknown>) => ({
    pipelines: [
      {
        id: 'p',
        agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', ...extra }],
      },
    ],
  });

  it('parses an agent with a full skillz declaration (all five categories)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(
      ws,
      baseAgent({
        skillz: {
          routers: ['skillzkit-product-router'],
          tools: ['core:tools:npm', 'core:tools:gh'],
          integrations: ['core:integrations:figma'],
          tasks: ['task:write-tests'],
          workflows: ['engineer:feature-build'],
        },
      }),
    );

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.skillz).toEqual({
      routers: ['skillzkit-product-router'],
      tools: ['core:tools:npm', 'core:tools:gh'],
      integrations: ['core:integrations:figma'],
      tasks: ['task:write-tests'],
      workflows: ['engineer:feature-build'],
    });
  });

  it('parses an agent with only routers (router-only SKILL bundle)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(
      ws,
      baseAgent({ skillz: { routers: ['skillzkit-product-router', 'skillzkit-eng-router'] } }),
    );

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.skillz?.routers).toEqual([
      'skillzkit-product-router',
      'skillzkit-eng-router',
    ]);
  });

  it('parses an agent with only some skillz categories present', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: { tools: ['core:tools:gh'] } }));

    const catalog = await loadCatalog(ws);
    const skillz: NonNullable<AgentDef['skillz']> | undefined =
      catalog.pipelines[0]?.agents[0]?.skillz;
    expect(skillz?.tools).toEqual(['core:tools:gh']);
    expect(skillz?.integrations).toBeUndefined();
    expect(skillz?.tasks).toBeUndefined();
    expect(skillz?.workflows).toBeUndefined();
  });

  it('parses an agent without a skillz field (backwards-compatible)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({}));

    const catalog = await loadCatalog(ws);
    expect(catalog.pipelines[0]?.agents[0]?.skillz).toBeUndefined();
  });

  it('throws when skillz is not an object', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: 'core:tools:npm' }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz must be an object/);
  });

  it('throws when skillz is an array (not an object)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: ['core:tools:npm'] }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz must be an object/);
  });

  it('throws on unknown skillz keys', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: { tools: [], surprises: ['x'] } }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz has unknown key "surprises"/);
  });

  it('throws when a skillz category is not an array', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: { tools: 'npm' } }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz\.tools must be an array of strings/);
  });

  it('throws when a skillz entry is not a string', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: { tools: ['core:tools:npm', 42] } }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz\.tools\[1\] must be a non-empty string/);
  });

  it('throws when a skillz entry is an empty string', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, baseAgent({ skillz: { tools: [''] } }));

    await expect(loadCatalog(ws)).rejects.toThrow(/skillz\.tools\[0\] must be a non-empty string/);
  });
});

describe('findPipeline', () => {
  const catalog: PipelineCatalog = {
    pipelines: [
      { id: 'a', agents: [{ id: 'x', role: 'X', adapter: 'claude-sdk' }] },
      { id: 'b', agents: [{ id: 'y', role: 'Y', adapter: 'claude-sdk' }] },
    ],
  };

  it('finds a pipeline by id', () => {
    expect(findPipeline(catalog, 'a')?.agents[0]?.id).toBe('x');
  });

  it('returns undefined for an unknown id', () => {
    expect(findPipeline(catalog, 'missing')).toBeUndefined();
  });
});

// ─── set-scoped accepts (Record form + resolveAccepts) ──────────────────────

describe('loadCatalog — Record-form accepts (named sets)', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const writeCatalog = async (workspaceRoot: string, body: object) => {
    const dir = join(workspaceRoot, '.harness', 'config');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pipelines.json'), JSON.stringify(body, null, 2), 'utf8');
  };

  it('parses Record-form accepts with multiple named sets', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            {
              id: 'a',
              role: 'A',
              adapter: 'claude-sdk',
              accepts: {
                default: ['anthropic:claude-haiku-4-5'],
                cheap: ['local-qwen:qwen3'],
                'bench-gpt': ['openai:gpt-4o'],
              },
            },
          ],
        },
      ],
    });

    const catalog = await loadCatalog(ws);
    const accepts = catalog.pipelines[0]?.agents[0]?.accepts;
    expect(accepts).toBeDefined();
    expect(accepts).not.toEqual(expect.any(Array));
    expect((accepts as Record<string, readonly string[]>).default).toEqual([
      'anthropic:claude-haiku-4-5',
    ]);
    expect((accepts as Record<string, readonly string[]>).cheap).toEqual(['local-qwen:qwen3']);
    expect((accepts as Record<string, readonly string[]>)['bench-gpt']).toEqual(['openai:gpt-4o']);
  });

  it('rejects an empty Record (no sets declared)', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: {} }],
        },
      ],
    });
    await expect(loadCatalog(ws)).rejects.toThrow(/must declare at least one set/);
  });

  it('rejects when a set name maps to a non-array value', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            {
              id: 'a',
              role: 'A',
              adapter: 'claude-sdk',
              accepts: { default: 'anthropic:claude-haiku-4-5' },
            },
          ],
        },
      ],
    });
    await expect(loadCatalog(ws)).rejects.toThrow(/must be an array/);
  });

  it('rejects when a set entry has malformed binding string', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [
            {
              id: 'a',
              role: 'A',
              adapter: 'claude-sdk',
              accepts: { default: ['anthropic-no-colon'] },
            },
          ],
        },
      ],
    });
    await expect(loadCatalog(ws)).rejects.toThrow(/must be of the form "<provider>:<model>"/);
  });

  it('rejects neither array nor object', async () => {
    const ws = tmpWorkspace();
    created.push(ws);
    await writeCatalog(ws, {
      pipelines: [
        {
          id: 'p',
          agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk', accepts: 42 }],
        },
      ],
    });
    await expect(loadCatalog(ws)).rejects.toThrow(/must be an array.*OR an object/);
  });
});

describe('resolveAccepts — projection by set name', () => {
  const flatAgent: AgentDef = {
    id: 'a',
    role: 'A',
    adapter: 'claude-sdk',
    accepts: ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3'],
  };

  const setAgent: AgentDef = {
    id: 'b',
    role: 'B',
    adapter: 'claude-sdk',
    accepts: {
      default: ['anthropic:claude-haiku-4-5'],
      cheap: ['local-qwen:qwen3'],
      'bench-gpt': ['openai:gpt-4o'],
    },
  };

  const partialSetAgent: AgentDef = {
    id: 'c',
    role: 'C',
    adapter: 'claude-sdk',
    accepts: {
      cheap: ['local-qwen:qwen3'],
      // no default!
    },
  };

  const noAcceptsAgent: AgentDef = {
    id: 'd',
    role: 'D',
    adapter: 'claude-sdk',
  };

  it('returns flat-form accepts unchanged regardless of set name', () => {
    expect(resolveAccepts(flatAgent, 'cheap')).toEqual([
      'anthropic:claude-haiku-4-5',
      'local-qwen:qwen3',
    ]);
    expect(resolveAccepts(flatAgent, 'bench-gpt')).toEqual([
      'anthropic:claude-haiku-4-5',
      'local-qwen:qwen3',
    ]);
    expect(resolveAccepts(flatAgent, 'default')).toEqual([
      'anthropic:claude-haiku-4-5',
      'local-qwen:qwen3',
    ]);
  });

  it('returns the named set when present', () => {
    expect(resolveAccepts(setAgent, 'default')).toEqual(['anthropic:claude-haiku-4-5']);
    expect(resolveAccepts(setAgent, 'cheap')).toEqual(['local-qwen:qwen3']);
    expect(resolveAccepts(setAgent, 'bench-gpt')).toEqual(['openai:gpt-4o']);
  });

  it('falls back to default when the named set is absent', () => {
    expect(resolveAccepts(setAgent, 'frontier')).toEqual(['anthropic:claude-haiku-4-5']);
    expect(resolveAccepts(setAgent, 'undefined-set')).toEqual(['anthropic:claude-haiku-4-5']);
  });

  it('throws when the named set is absent AND no default declared', () => {
    expect(() => resolveAccepts(partialSetAgent, 'frontier')).toThrow(
      /agent "c" has no "frontier" set and no "default" set/,
    );
    expect(() => resolveAccepts(partialSetAgent, 'frontier')).toThrow(/declared sets: cheap/);
  });

  it('returns undefined when accepts is undefined', () => {
    expect(resolveAccepts(noAcceptsAgent, 'default')).toBeUndefined();
    expect(resolveAccepts(noAcceptsAgent, 'cheap')).toBeUndefined();
  });

  it('uses set name match exactly (case-sensitive)', () => {
    // 'Cheap' (capital C) is not the same as 'cheap'
    expect(resolveAccepts(setAgent, 'Cheap')).toEqual(['anthropic:claude-haiku-4-5']);
    // ↑ falls back to default because 'Cheap' isn't declared
  });
});

describe('validateUnifiedCatalog — ProductDef.repos (slice 9d-5)', () => {
  // Helper: get the validator under a fresh import each call so
  // we can lean on plain object inputs.
  async function importValidator() {
    return (await import('./catalog.ts')).validateUnifiedCatalog;
  }

  it('accepts a product with a valid repos array', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [
            {
              id: 'mobile-app',
              repos: [
                { name: 'web-app', cloneUrl: 'git@github.com:org/web-app.git' },
                {
                  name: 'api',
                  cloneUrl: 'https://github.com/org/api.git',
                  baseRef: 'develop',
                  path: '/workspace/services/api',
                },
              ],
            },
          ],
        },
        'test',
      ),
    ).not.toThrow();
  });

  it('accepts a product without repos (legacy / context-only product)', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [{ id: 'context-only', contextSources: [] }],
        },
        'test',
      ),
    ).not.toThrow();
  });

  it('rejects repos that is not an array', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [{ id: 'p', repos: 'not-an-array' }],
        },
        'test',
      ),
    ).toThrow(/repos must be an array/);
  });

  it('rejects a repo entry without a name', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [
            {
              id: 'p',
              repos: [{ cloneUrl: 'https://github.com/org/r.git' }],
            },
          ],
        },
        'test',
      ),
    ).toThrow(/name must be a non-empty string/);
  });

  it('rejects a repo entry without a cloneUrl', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [{ id: 'p', repos: [{ name: 'r' }] }],
        },
        'test',
      ),
    ).toThrow(/cloneUrl must be a non-empty string/);
  });

  it('rejects duplicate repo names within a product', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [
            {
              id: 'p',
              repos: [
                { name: 'shared', cloneUrl: 'a' },
                { name: 'shared', cloneUrl: 'b' },
              ],
            },
          ],
        },
        'test',
      ),
    ).toThrow(/duplicate name "shared"/);
  });

  it('rejects empty-string baseRef / path overrides', async () => {
    const validate = await importValidator();
    expect(() =>
      validate(
        {
          pipelines: [],
          products: [
            {
              id: 'p',
              repos: [{ name: 'r', cloneUrl: 'u', baseRef: '' }],
            },
          ],
        },
        'test',
      ),
    ).toThrow(/baseRef must be a non-empty string/);
  });
});
