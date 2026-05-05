/**
 * Integration test for Phase C.7's cross-source-type Documents edges.
 *
 * Spins up a tiny "OSS package" with both src/ + docs/ + package.json,
 * runs oss-code ingest first (so OssFunction nodes exist), then runs
 * oss-docs ingest (which auto-fires linkDocumentsToSymbols at the end).
 * Asserts that Documents edges land from OssSection → OssFunction when
 * the section text contains the function name.
 *
 * Gated behind RUN_NEO4J_INTEGRATION=1 because it requires a live
 * Neo4j + the same Docker Model Runner embedder used by the other
 * integration tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Neo4jBackend, ingest } from '../index.ts';
import type { EmbedderClient } from '../index.ts';

const RUN_INTEGRATION = process.env.RUN_NEO4J_INTEGRATION === '1';
const NEO4J_URL = process.env.NEO4J_TEST_URL ?? 'bolt://localhost:7687';
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'devpassword';

// Unique per-run package name so concurrent CI shards or repeated
// local runs don't share state. The link test queries by Package id;
// using a unique id keeps the assertion bounded.
const RUN_ID = `t${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const PKG_NAME = `linktest-${RUN_ID}`;
const PKG_VERSION = '1.0.0';

function mockEmbedder(dim = 8): EmbedderClient {
  let counter = 0;
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        counter++;
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = (counter * (i + 1)) % 7;
        return v;
      });
    },
  };
}

describe.skipIf(!RUN_INTEGRATION)(
  'ingest() — Documents edges from oss-docs to oss-code (C.7)',
  () => {
    let workdir: string;
    let backend: Neo4jBackend;

    beforeAll(async () => {
      // Synthesize a tiny package with two functions + two doc files
      // that name them.
      workdir = mkdtempSync('/tmp/link-test-');
      writeFileSync(
        join(workdir, 'package.json'),
        JSON.stringify({ name: PKG_NAME, version: PKG_VERSION })
      );
      mkdirSync(join(workdir, 'src'));
      writeFileSync(
        join(workdir, 'src', 'hooks.ts'),
        'export function useState(initial) { return initial; }\nexport function useEffect(fn) { fn(); }\n'
      );
      mkdirSync(join(workdir, 'docs'));
      writeFileSync(
        join(workdir, 'docs', 'guide.md'),
        '# Guide\n\n## State\n\nUse useState to track a value.\n\n## Effects\n\nuseEffect runs after render.\n'
      );

      backend = new Neo4jBackend({
        url: NEO4J_URL,
        password: NEO4J_PASSWORD,
        vectorDim: 8,
      });

      // 1. Ingest the OSS code first → OssFunction nodes appear,
      //    BelongsTo edges link them to Version.
      await ingest({
        source: { type: 'oss-code', ref: { kind: 'path', path: workdir } },
        backend,
        embedderClient: mockEmbedder(8),
      });

      // 2. Ingest the docs → OssDoc + OssSection nodes appear, then
      //    linkDocumentsToSymbols auto-fires at end-of-ingest and
      //    creates Documents edges.
      await ingest({
        source: { type: 'oss-docs', ref: { kind: 'path', path: workdir } },
        backend,
        embedderClient: mockEmbedder(8),
      });
    }, 60_000);

    afterAll(async () => {
      // Drop everything tagged with this package's Version. DETACH
      // DELETE handles edges automatically.
      const session = (
        backend as unknown as { driver: { session(): unknown } }
      ).driver.session() as {
        run(q: string, p?: object): Promise<unknown>;
        close(): Promise<void>;
      };
      try {
        // Find every node BelongsTo-attached to the test Version, plus
        // the Version + Package themselves, plus any sections/files
        // they Contains. Cypher's DETACH DELETE wipes attached edges.
        await session.run(
          `MATCH (p:Package {name: $pkg})
           OPTIONAL MATCH (p)<-[:BelongsTo]-(v:Version)
           OPTIONAL MATCH (v)<-[:BelongsTo]-(rooted)
           OPTIONAL MATCH (rooted)-[:Contains]->(child)
           DETACH DELETE p, v, rooted, child`,
          { pkg: PKG_NAME }
        );
      } finally {
        await session.close();
      }
      await backend.close();
    });

    it('emits Documents edges where section text matches a function name', async () => {
      const session = (
        backend as unknown as { driver: { session(): unknown } }
      ).driver.session() as {
        run(q: string, p?: object): Promise<{
          records: Array<{ get(k: string): unknown }>;
        }>;
        close(): Promise<void>;
      };
      try {
        const r = await session.run(
          `MATCH (p:Package {name: $pkg})<-[:BelongsTo]-(v:Version)
           MATCH (sec:OssSection)-[:Documents]->(sym)
           MATCH (file:OssFile)-[:Contains]->(sym)
           MATCH (file)-[:BelongsTo]->(v)
           RETURN sec.heading AS heading, sym.name AS name`,
          { pkg: PKG_NAME }
        );
        const pairs = r.records.map((rec) => ({
          heading: rec.get('heading') as string,
          name: rec.get('name') as string,
        }));
        // We expect at least:
        //   "State" section → useState function
        //   "Effects" section → useEffect function
        const names = pairs.map((p) => p.name).sort();
        expect(names).toEqual(expect.arrayContaining(['useEffect', 'useState']));
        const stateLink = pairs.find((p) => p.name === 'useState');
        expect(stateLink?.heading).toBe('State');
      } finally {
        await session.close();
      }
    });

    it('does not emit Documents edges for unrelated sections', async () => {
      // The "Guide" intro section ("# Guide") doesn't mention any
      // function name, so it should have no Documents edges.
      const session = (
        backend as unknown as { driver: { session(): unknown } }
      ).driver.session() as {
        run(q: string, p?: object): Promise<{
          records: Array<{ get(k: string): unknown }>;
        }>;
        close(): Promise<void>;
      };
      try {
        const r = await session.run(
          `MATCH (p:Package {name: $pkg})<-[:BelongsTo]-(v:Version)
           MATCH (doc:OssDoc)-[:BelongsTo]->(v)
           MATCH (doc)-[:Contains]->(sec:OssSection)
             WHERE sec.heading = 'Guide'
           OPTIONAL MATCH (sec)-[r:Documents]->()
           RETURN count(r) AS edges`,
          { pkg: PKG_NAME }
        );
        const rec = r.records[0]!;
        const edges = rec.get('edges') as { toNumber(): number } | number;
        const n = typeof edges === 'number' ? edges : edges.toNumber();
        expect(n).toBe(0);
      } finally {
        await session.close();
      }
    });
  }
);
