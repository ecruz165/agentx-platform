import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogError, findPipeline, loadCatalog, type PipelineCatalog } from './catalog.ts';

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
      'utf8'
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
