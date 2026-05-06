/**
 * runAgentWorker tests — exercises the full chain except for the LLM
 * runtime itself (which is stubbed via the spec.invokeAgent override
 * so tests stay fast + offline).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentWorker } from './index.ts';

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-worker-e2e-'));
  // Two skills under the runtime tree.
  mkdirSync(join(dir, '.harness/skills'), { recursive: true });
  writeFileSync(
    join(dir, '.harness/skills/memory.md'),
    '# SKILL: memory\n\nUse `harness memory query/put`.\n'
  );
  writeFileSync(
    join(dir, '.harness/skills/context.md'),
    '# SKILL: context\n\nUse `harness context query`.\n'
  );
  return dir;
}

describe('runAgentWorker', () => {
  it('runs end-to-end with a stub agent: loads skills + builds prompt + invokes + returns response', async () => {
    const ws = makeWorkspace();
    try {
      let capturedPrompt = '';
      const result = await runAgentWorker({
        jobId: 'test-001',
        workspaceRoot: ws,
        task: 'Where is FileBroker defined?',
        invokeAgent: async ({ systemPrompt, task }) => {
          capturedPrompt = systemPrompt;
          return `Stub agent saw task "${task}" with a ${systemPrompt.length}-char prompt.`;
        },
      });
      expect(result.jobId).toBe('test-001');
      expect(result.skillNames.sort()).toEqual(['context', 'memory']);
      expect(result.systemPrompt).toContain('SKILL: memory');
      expect(result.systemPrompt).toContain('SKILL: context');
      expect(result.systemPrompt).toContain('agent-test-001'); // tmux session name in preamble
      expect(result.response).toContain('Where is FileBroker defined?');
      // Sandbox dirs got created
      expect(existsSync(join(ws, '.harness/agent_home'))).toBe(true);
      expect(existsSync(join(ws, '.harness/tmp'))).toBe(true);
      // No tmux session by default.
      expect(result.hadTmuxSession).toBe(false);
      // The stub saw the same prompt the result reports.
      expect(capturedPrompt).toBe(result.systemPrompt);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('respects the skills filter — only requested skills make it into the prompt', async () => {
    const ws = makeWorkspace();
    try {
      const result = await runAgentWorker({
        jobId: 't',
        workspaceRoot: ws,
        task: 'x',
        skills: ['memory'],
        invokeAgent: async () => 'ok',
      });
      expect(result.skillNames).toEqual(['memory']);
      expect(result.systemPrompt).toContain('SKILL: memory');
      expect(result.systemPrompt).not.toContain('SKILL: context');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('default agent (no invokeAgent override) returns the placeholder response', async () => {
    const ws = makeWorkspace();
    try {
      const result = await runAgentWorker({
        jobId: 't',
        workspaceRoot: ws,
        task: 'placeholder check',
      });
      expect(result.response).toContain('[agent-worker placeholder]');
      expect(result.response).toContain('placeholder check');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
