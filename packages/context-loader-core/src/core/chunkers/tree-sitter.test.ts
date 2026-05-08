/**
 * Unit tests for the tree-sitter / code-full chunker.
 *
 * These do not need a Neo4j server — the chunker emits in-memory node
 * arrays. The actual end-to-end test (chunker + ingest + Neo4j) lives in
 * ingest.test.ts and is gated behind RUN_NEO4J_INTEGRATION=1.
 */

import { describe, expect, it } from 'vitest';
import { chunkCodeFull, pickGrammar } from './tree-sitter.ts';

describe('pickGrammar', () => {
  it('maps known extensions to grammars', () => {
    expect(pickGrammar('src/foo.ts')).toBe('typescript');
    expect(pickGrammar('Component.tsx')).toBe('tsx');
    expect(pickGrammar('app.js')).toBe('javascript');
    expect(pickGrammar('script.mjs')).toBe('javascript');
    expect(pickGrammar('data.py')).toBe('python');
    // PRD F25 mandates Java; bonus grammars added 2026-05-08.
    expect(pickGrammar('Main.java')).toBe('java');
    expect(pickGrammar('main.go')).toBe('go');
    expect(pickGrammar('lib.rs')).toBe('rust');
    expect(pickGrammar('Service.cs')).toBe('c-sharp');
    expect(pickGrammar('foo.cpp')).toBe('cpp');
    expect(pickGrammar('foo.c')).toBe('c');
    expect(pickGrammar('foo.rb')).toBe('ruby');
    expect(pickGrammar('foo.php')).toBe('php');
  });

  it('returns null for unknown extensions', () => {
    expect(pickGrammar('README.md')).toBeNull();
    expect(pickGrammar('config.yaml')).toBeNull();
    expect(pickGrammar('Dockerfile')).toBeNull();
  });

  it('is case-insensitive on extensions', () => {
    expect(pickGrammar('Foo.TS')).toBe('typescript');
    expect(pickGrammar('Bar.PY')).toBe('python');
  });
});

describe('chunkCodeFull — TypeScript', () => {
  it('emits a File node + Function nodes for top-level declarations', async () => {
    const src = `
export function hello(name: string): string {
  return \`hi \${name}\`;
}

export class Greeter {
  constructor(private prefix: string) {}
  greet(name: string): string {
    return \`\${this.prefix} \${name}\`;
  }
}

function helper(x: number): number {
  return x + 1;
}
`;
    const out = await chunkCodeFull({
      relativePath: 'src/test.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test-workspace',
    });

    // 1 File node + 4 declarations (hello, Greeter, helper, and the
    // class's `greet` method — `constructor` is a method_definition too)
    const fileNodes = out.nodes.filter((n) => n.label === 'File');
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0]!.id).toBe('src/test.ts');

    const fnNodes = out.nodes.filter((n) => n.label === 'Function');
    const classNodes = out.nodes.filter((n) => n.label === 'Class');
    expect(classNodes.map((n) => n.properties.name)).toContain('Greeter');
    expect(fnNodes.map((n) => n.properties.name)).toEqual(
      expect.arrayContaining(['hello', 'helper']),
    );
  });

  it('emits Contains edges from the File to every declaration', async () => {
    const src = `
function a() {}
function b() {}
class C {}
`;
    const out = await chunkCodeFull({
      relativePath: 'm.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    const contains = out.edges.filter((e) => e.label === 'Contains');
    // 3 top-level declarations → 3 Contains edges from m.ts
    expect(contains).toHaveLength(3);
    for (const e of contains) {
      expect(e.from).toBe('m.ts');
      expect(e.to.startsWith('m.ts#')).toBe(true);
    }
  });

  it('produces one chunk per declaration', async () => {
    const src = `
function alpha() { return 1; }
function beta() { return 2; }
`;
    const out = await chunkCodeFull({
      relativePath: 'x.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[0]!.text).toContain('alpha');
    expect(out.chunks[1]!.text).toContain('beta');
  });

  it('records start/end line and char count on each declaration node', async () => {
    const src = `// header\n\nfunction first() {\n  return 1;\n}\n`;
    const out = await chunkCodeFull({
      relativePath: 't.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    const fn = out.nodes.find((n) => n.label === 'Function' && n.properties.name === 'first');
    expect(fn).toBeDefined();
    expect(fn!.properties.startLine).toBe(3);
    expect(fn!.properties.endLine).toBe(5);
    expect(fn!.properties.lineCount).toBe(3);
    expect(typeof fn!.properties.charCount).toBe('number');
  });

  it('disambiguates same-name declarations by start line in the id', async () => {
    // Same name twice in the same file (legal in some shapes — e.g.,
    // function overload signatures + impl). The id must encode the line
    // so MERGE doesn't collapse them.
    const src = `
function foo(a: number): number;
function foo(a: string): string;
function foo(a: number | string): number | string {
  return a;
}
`;
    const out = await chunkCodeFull({
      relativePath: 'd.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    const ids = out.nodes.filter((n) => n.label === 'Function').map((n) => n.id);
    // All foo ids are unique because the line number is part of the id.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('chunkCodeFull — labelPrefix', () => {
  it('default behavior is unchanged (no prefix)', async () => {
    const out = await chunkCodeFull({
      relativePath: 't.ts',
      content: 'function f() {}\nclass C {}\n',
      sourceTypeId: 'code-full',
      sourceId: 'ws',
    });
    const labels = new Set(out.nodes.map((n) => n.label));
    expect(labels.has('File')).toBe(true);
    expect(labels.has('Function')).toBe(true);
    expect(labels.has('Class')).toBe(true);
  });

  it('prefixes File / Function / Class with the labelPrefix', async () => {
    const out = await chunkCodeFull({
      relativePath: 'pkg.ts',
      content: 'function f() {}\nclass C {}\n',
      sourceTypeId: 'oss-code',
      sourceId: 'react@18.2.0',
      labelPrefix: 'Oss',
    });
    const labels = new Set(out.nodes.map((n) => n.label));
    expect(labels.has('OssFile')).toBe(true);
    expect(labels.has('OssFunction')).toBe(true);
    expect(labels.has('OssClass')).toBe(true);
    // Plain (un-prefixed) labels should NOT appear.
    expect(labels.has('File')).toBe(false);
    expect(labels.has('Function')).toBe(false);
    expect(labels.has('Class')).toBe(false);
  });

  it('Contains edge label is not prefixed (edge schema has its own naming)', async () => {
    const out = await chunkCodeFull({
      relativePath: 'pkg.ts',
      content: 'function f() {}\n',
      sourceTypeId: 'oss-code',
      sourceId: 'pkg@1.0.0',
      labelPrefix: 'Oss',
    });
    const containsEdges = out.edges.filter((e) => e.label === 'Contains');
    expect(containsEdges.length).toBeGreaterThan(0);
    // No 'OssContains' edges — labelPrefix only affects nodes for now.
    expect(out.edges.find((e) => e.label === 'OssContains')).toBeUndefined();
  });
});

describe('chunkCodeFull — extension dispatch', () => {
  it('returns empty output for unsupported extensions', async () => {
    const out = await chunkCodeFull({
      relativePath: 'README.md',
      content: '# A markdown file is not code',
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    expect(out.nodes).toHaveLength(0);
    expect(out.edges).toHaveLength(0);
    expect(out.chunks).toHaveLength(0);
  });
});

describe('chunkCodeFull — skeleton-only mode (oss-code style)', () => {
  it('emits chunk text up to but not including the function body', async () => {
    const src = `
export function calculate(x: number, y: number): number {
  // ~10x more text in the body than the signature
  const intermediate = x * y * x * y;
  const result = intermediate + intermediate / 2;
  return Math.round(result);
}
`;
    const out = await chunkCodeFull({
      relativePath: 'lib.ts',
      content: src,
      sourceTypeId: 'oss-code',
      sourceId: 'react@18.2.0',
      mode: 'skeleton-only',
    });
    expect(out.chunks).toHaveLength(1);
    const text = out.chunks[0]!.text;
    expect(text).toContain('export function calculate(x: number, y: number): number');
    // Body content must NOT be in the chunk.
    expect(text).not.toContain('Math.round');
    expect(text).not.toContain('intermediate');
  });

  it('records mode + fullCharCount on the node so callers can compare footprints', async () => {
    const src = `function tiny(): void { console.log('lots of body content here'); }\n`;
    const out = await chunkCodeFull({
      relativePath: 't.ts',
      content: src,
      sourceTypeId: 'oss-code',
      sourceId: 'pkg@1.0.0',
      mode: 'skeleton-only',
    });
    const fn = out.nodes.find((n) => n.label === 'Function');
    expect(fn!.properties.mode).toBe('skeleton-only');
    // The skeleton chunk text is shorter than the original declaration.
    expect(fn!.properties.charCount).toBeLessThan(fn!.properties.fullCharCount as number);
  });

  it('skeleton mode produces strictly less text than full mode for the same input', async () => {
    const src = `
function compute(a: number): number {
  return a * a + 1;
}
`;
    const full = await chunkCodeFull({
      relativePath: 't.ts',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'ws',
      mode: 'full',
    });
    const skel = await chunkCodeFull({
      relativePath: 't.ts',
      content: src,
      sourceTypeId: 'oss-code',
      sourceId: 'ws',
      mode: 'skeleton-only',
    });
    expect(full.chunks[0]!.text.length).toBeGreaterThan(skel.chunks[0]!.text.length);
  });

  it('Python skeleton stops at the function body (after the colon)', async () => {
    const src = `
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b
`;
    const out = await chunkCodeFull({
      relativePath: 'm.py',
      content: src,
      sourceTypeId: 'oss-code',
      sourceId: 'pypi-pkg',
      mode: 'skeleton-only',
    });
    const text = out.chunks[0]!.text;
    expect(text).toContain('def add(a: int, b: int) -> int');
    // The actual body (return statement) must not be in the skeleton.
    expect(text).not.toContain('return a + b');
  });
});

describe('chunkCodeFull — Python', () => {
  it('extracts function and class definitions', async () => {
    const src = `
def add(a, b):
    return a + b

class Counter:
    def __init__(self):
        self.n = 0
    def inc(self):
        self.n += 1
`;
    const out = await chunkCodeFull({
      relativePath: 'lib.py',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    const names = out.nodes.map((n) => n.properties.name);
    expect(names).toContain('add');
    expect(names).toContain('Counter');
  });
});

describe('chunkCodeFull — Java', () => {
  it('extracts class + method declarations', async () => {
    const src = `
package com.example;

public class Greeter {
  private final String prefix;

  public Greeter(String prefix) {
    this.prefix = prefix;
  }

  public String greet(String name) {
    return prefix + " " + name;
  }
}

interface Renderable {
  String render();
}
`;
    const out = await chunkCodeFull({
      relativePath: 'src/Greeter.java',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    // v1 chunker doesn't descend into class bodies (Phase D work) —
    // we get the class + interface, not their methods.
    const names = out.nodes.map((n) => n.properties.name);
    expect(names).toContain('Greeter');
    expect(names).toContain('Renderable');
  });
});

describe('chunkCodeFull — Go', () => {
  it('extracts function + method declarations', async () => {
    const src = `
package main

import "fmt"

type Greeter struct {
  prefix string
}

func (g Greeter) Greet(name string) string {
  return g.prefix + " " + name
}

func main() {
  fmt.Println("hello")
}
`;
    const out = await chunkCodeFull({
      relativePath: 'main.go',
      content: src,
      sourceTypeId: 'code-full',
      sourceId: 'test',
    });
    const names = out.nodes.map((n) => n.properties.name);
    expect(names).toContain('main');
    expect(names).toContain('Greet');
  });
});
