/**
 * Unit tests for the skill loader + prompt builder.
 *
 * The tests synthesize tiny in-memory workspaces (mkdtemp + writeFile)
 * and verify:
 *   - skills load from <root>/.harness/skills/ first, then
 *     workspace-template/.harness/skills/ as fallback
 *   - the runtime location wins on name collision
 *   - the `skills` filter restricts what gets loaded
 *   - buildSystemPrompt produces a single string with all skills + the
 *     PRD §3 sandboxing preamble
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, loadWorkspaceSkills } from './skill-prompt.ts';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'agent-worker-skills-'));
});

function ws(rel: string, content: string): void {
  const path = join(workdir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('loadWorkspaceSkills', () => {
  it('loads every *.md from <root>/.harness/skills/', async () => {
    ws('.harness/skills/memory.md', '# memory\n');
    ws('.harness/skills/context.md', '# context\n');
    ws('.harness/skills/not-a-skill.txt', 'nope\n');
    const skills = await loadWorkspaceSkills({ workspaceRoot: workdir });
    expect(skills.map((s) => s.name).sort()).toEqual(['context', 'memory']);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('falls back to workspace-template/.harness/skills/ when runtime tree is empty', async () => {
    ws('workspace-template/.harness/skills/memory.md', '# template memory\n');
    const skills = await loadWorkspaceSkills({ workspaceRoot: workdir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('memory');
    expect(skills[0]!.content).toContain('template memory');
    rmSync(workdir, { recursive: true, force: true });
  });

  it('prefers runtime over template on name collision', async () => {
    ws('workspace-template/.harness/skills/memory.md', '# template (loses)\n');
    ws('.harness/skills/memory.md', '# runtime (wins)\n');
    const skills = await loadWorkspaceSkills({ workspaceRoot: workdir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.content).toContain('runtime (wins)');
    expect(skills[0]!.content).not.toContain('loses');
    rmSync(workdir, { recursive: true, force: true });
  });

  it('respects the `skills` filter', async () => {
    ws('.harness/skills/memory.md', '# memory\n');
    ws('.harness/skills/context.md', '# context\n');
    ws('.harness/skills/harness-cli.md', '# cli\n');
    const skills = await loadWorkspaceSkills({
      workspaceRoot: workdir,
      skills: ['memory', 'context'],
    });
    expect(skills.map((s) => s.name).sort()).toEqual(['context', 'memory']);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('returns [] when neither location exists', async () => {
    const skills = await loadWorkspaceSkills({ workspaceRoot: workdir });
    expect(skills).toEqual([]);
    rmSync(workdir, { recursive: true, force: true });
  });
});

describe('buildSystemPrompt', () => {
  it('embeds the PRD §3 sandbox preamble + every skill block', () => {
    const prompt = buildSystemPrompt({
      jobId: 'job-001',
      workspaceRoot: '/ws/root',
      skills: [
        { name: 'memory', path: '/ws/.harness/skills/memory.md', content: '# memory\nmem-content' },
        {
          name: 'context',
          path: '/ws/.harness/skills/context.md',
          content: '# context\nctx-content',
        },
      ],
    });
    // Sandbox preamble fields
    expect(prompt).toContain('sandboxed agent worker');
    expect(prompt).toContain('/ws/root');
    expect(prompt).toContain('agent-job-001');
    expect(prompt).toContain('harness attach');
    expect(prompt).toContain('MCP is banned');
    // Skill blocks present + delimited
    expect(prompt).toContain('<<<SKILL: memory');
    expect(prompt).toContain('mem-content');
    expect(prompt).toContain('<<<END SKILL: memory>>>');
    expect(prompt).toContain('<<<SKILL: context');
    expect(prompt).toContain('ctx-content');
  });

  it('appends an optional jobPreamble after the sandbox text', () => {
    const prompt = buildSystemPrompt({
      jobId: 'j',
      workspaceRoot: '/ws',
      skills: [],
      jobPreamble: 'Per-job hint: focus on auth flows.',
    });
    expect(prompt).toContain('Per-job hint: focus on auth flows.');
  });
});
