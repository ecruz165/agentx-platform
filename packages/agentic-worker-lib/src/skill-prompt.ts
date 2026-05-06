/**
 * Workspace SKILL.md loading + concatenation.
 *
 * Per the agent-worker PRD §3, the worker injects a SKILL.md as the
 * agent's system prompt. The agentx workspace template ships several
 * skills (memory, context, harness-cli) that together describe the
 * full surface an agent is allowed to use. The worker concatenates
 * them into one prompt string at startup; the agent sees a unified
 * skill catalog rather than per-tool fragments.
 *
 * Discovery order:
 *   1. <workspaceRoot>/.harness/skills/<name>.md  — workspace-local
 *   2. <workspaceRoot>/workspace-template/.harness/skills/<name>.md
 *      — fallback for the agentx repo's self-hosted layout
 *
 * The two locations exist because workspace-template/ is what gets
 * checked into the agentx repo (versioned reference skills), while
 * .harness/ is the per-workspace runtime tree (potentially overridden
 * by operators). When both exist, workspace-local wins.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadSkillsOptions {
  workspaceRoot: string;
  /** Optional restriction to specific skill names (without `.md`).
   *  Default: load every *.md found. */
  skills?: string[];
}

export interface LoadedSkill {
  name: string;
  path: string;
  content: string;
}

const RUNTIME_SUBPATH = ['.harness', 'skills'];
const TEMPLATE_SUBPATH = ['workspace-template', '.harness', 'skills'];

export async function loadWorkspaceSkills(
  opts: LoadSkillsOptions
): Promise<LoadedSkill[]> {
  const dirs = [
    join(opts.workspaceRoot, ...RUNTIME_SUBPATH),
    join(opts.workspaceRoot, ...TEMPLATE_SUBPATH),
  ].filter(existsSync);

  const seen = new Map<string, LoadedSkill>();

  for (const dir of dirs) {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.replace(/\.md$/, '');
      if (opts.skills && !opts.skills.includes(name)) continue;
      // First-seen wins — workspace-local skills in the runtime tree
      // override the workspace-template fallback.
      if (seen.has(name)) continue;
      const path = join(dir, entry);
      const content = await readFile(path, 'utf8');
      seen.set(name, { name, path, content });
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Concatenate skills into a single system-prompt string.
 *
 * Format: each skill is preceded by a thin separator with the source
 * path so the agent can attribute behaviors back to specific skills
 * if it ever reasons about them. The final prompt is wrapped with a
 * brief preamble about the agent's environment (per PRD §3's
 * "Reference SKILL.md" template).
 */
export function buildSystemPrompt(args: {
  jobId: string;
  workspaceRoot: string;
  skills: LoadedSkill[];
  /** Free-form per-job preamble appended after the standard one.
   *  Used by the harness to inject job-specific context. */
  jobPreamble?: string;
}): string {
  const sandboxPreamble = [
    'You are executing a task within a sandboxed agent worker.',
    '',
    `1. WORKSPACE ROOT: All filesystem operations are relative to ${args.workspaceRoot}.`,
    '   Do not reach outside this tree unless the task profile explicitly requires it.',
    `2. TERMINAL: You are running inside the tmux session "agent-${args.jobId}".`,
    '   A developer may peek into your console at any time using `harness attach`.',
    '   Output clear, ANSI-compatible progress logs with descriptive headers.',
    '3. TOOLS: You access memory, context, and other workspace services through',
    '   the `harness` CLI (Bash tool). MCP is banned ecosystem-wide; do not call',
    '   any MCP server. Specific subcommand surfaces are documented in the skills',
    '   below — read them carefully before acting.',
    '4. HEARTBEAT: Use `workspace.heartbeat` (when available) every ~30s with a',
    '   short status + thinking summary so the harness-server can show liveness.',
  ].join('\n');

  const skillBlocks = args.skills.map((s) => {
    return [`<<<SKILL: ${s.name} (${s.path})>>>`, s.content.trimEnd(), `<<<END SKILL: ${s.name}>>>`].join(
      '\n'
    );
  });

  const parts: string[] = [sandboxPreamble];
  if (args.jobPreamble) parts.push('', args.jobPreamble);
  parts.push('', '────────────────────────────────────────', '');
  parts.push(...skillBlocks);
  return parts.join('\n');
}
