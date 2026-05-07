/** @jsxImportSource @opentui/react */

import { validateRepoAccess } from '@ecruz165/harness-server';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useState } from 'react';
import { looksLikeOrgUrl, repoNameFromUrl, suggestRepoFromOrgUrl } from './procure.ts';
import type { ProcureSpec, RepoSpec } from './types.ts';

/**
 * OpenTUI form for the procurement flow. Renders prefilled with whatever
 * the CLI received and prompts for the rest. Validates each repo URL
 * incrementally via validateRepoAccess (debounced).
 *
 * Modes:
 *   - 'name'   — editing product name
 *   - 'repos'  — editing the repos list
 *   - 'review' — read-only summary; press Enter to submit
 *
 * Submission resolves with a complete ProcureSpec or `null` if the user
 * pressed Ctrl+C / Esc to abort.
 */

interface TuiProps {
  initial: {
    name?: string;
    repos?: string[];
    dest?: string;
    tokenEnv?: string;
    noClone?: boolean;
  };
  onSubmit: (spec: ProcureSpec) => void;
  onAbort: () => void;
}

type RepoCheckState = 'pending' | 'ok' | 'fail' | 'org';

interface RepoEntry {
  url: string;
  state: RepoCheckState;
  reason?: string;
  suggestion?: string;
}

function App({ initial, onSubmit, onAbort }: TuiProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [repos, setRepos] = useState<RepoEntry[]>(
    (initial.repos ?? []).map((url) => ({
      url,
      state: looksLikeOrgUrl(url) ? 'org' : 'pending',
    })),
  );
  const [mode, setMode] = useState<'name' | 'repos' | 'review'>(
    initial.name ? (initial.repos?.length ? 'review' : 'repos') : 'name',
  );
  const [editBuffer, setEditBuffer] = useState<string>('');
  const [hint, setHint] = useState<string | null>(null);

  // Run validateRepoAccess on the current repos list whenever it changes.
  useEffect(() => {
    const pending = repos.filter((r) => r.state === 'pending');
    if (pending.length === 0) return;
    let cancelled = false;
    validateRepoAccess({
      repos: pending.map((r) => ({ name: repoNameFromUrl(r.url), cloneUrl: r.url })),
      ...(initial.tokenEnv && process.env[initial.tokenEnv]
        ? {
            cloneEnv: {
              GIT_TERMINAL_PROMPT: '0',
              GIT_HTTP_EXTRAHEADER: `Authorization: Bearer ${process.env[initial.tokenEnv]}`,
            },
          }
        : {}),
      parallel: true,
    }).then((res) => {
      if (cancelled) return;
      setRepos((prev) =>
        prev.map((r) => {
          if (r.state !== 'pending') return r;
          const check = res.all.find((c) => c.repo.cloneUrl === r.url);
          if (!check) return r;
          return check.ok
            ? { ...r, state: 'ok' }
            : {
                ...r,
                state: 'fail',
                ...(check.reason ? { reason: check.reason } : {}),
                ...(check.suggestion ? { suggestion: check.suggestion } : {}),
              };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [repos, initial.tokenEnv]);

  const allValid = useMemo(
    () => name.trim() !== '' && repos.length > 0 && repos.every((r) => r.state === 'ok'),
    [name, repos],
  );

  useKeyboard((e) => {
    if (e.name === 'escape' || (e.ctrl && e.name === 'c')) {
      onAbort();
      return;
    }

    if (mode === 'name') {
      if (e.name === 'return') {
        if (name.trim() === '') {
          setHint('Product name is required');
          return;
        }
        setHint(null);
        setMode(repos.length === 0 ? 'repos' : 'review');
      } else if (e.name === 'backspace') {
        setName((n) => n.slice(0, -1));
      } else if (e.sequence && e.sequence.length === 1 && !e.ctrl) {
        setName((n) => n + e.sequence);
      }
    } else if (mode === 'repos') {
      if (e.name === 'return') {
        if (editBuffer.trim() === '') {
          // Empty Enter advances to review if at least one repo is present.
          if (repos.some((r) => r.state === 'ok')) {
            setMode('review');
            setHint(null);
          } else {
            setHint('At least one valid repo is required');
          }
          return;
        }
        const url = editBuffer.trim();
        if (looksLikeOrgUrl(url)) {
          const suggestion = suggestRepoFromOrgUrl(url, name);
          setRepos((rs) => [
            ...rs,
            { url, state: 'org', reason: 'looks like an org URL', suggestion },
          ]);
        } else {
          setRepos((rs) => [...rs, { url, state: 'pending' }]);
        }
        setEditBuffer('');
        setHint(null);
      } else if (e.name === 'backspace') {
        setEditBuffer((b) => b.slice(0, -1));
      } else if (e.ctrl && e.name === 'd' && repos.length > 0) {
        // Ctrl+D removes the last entry.
        setRepos((rs) => rs.slice(0, -1));
      } else if (e.ctrl && e.name === 'b') {
        setMode('name');
      } else if (e.sequence && e.sequence.length === 1 && !e.ctrl) {
        setEditBuffer((b) => b + e.sequence);
      }
    } else if (mode === 'review') {
      if (e.name === 'return' && allValid) {
        const validRepos: RepoSpec[] = repos
          .filter((r) => r.state === 'ok')
          .map((r) => ({ name: repoNameFromUrl(r.url), cloneUrl: r.url }));
        const spec: ProcureSpec = {
          name: name.trim(),
          repos: validRepos,
          dest: initial.dest ?? `./workspace-${name.trim()}`,
          ...(initial.tokenEnv ? { tokenEnv: initial.tokenEnv } : {}),
          noClone: initial.noClone ?? false,
        };
        onSubmit(spec);
      } else if (e.name === 'e') {
        setMode('repos');
      } else if (e.ctrl && e.name === 'b') {
        setMode('repos');
      }
    }
  });

  return (
    <box flexDirection="column" padding={1}>
      <text fg="#06b6d4">agentx-workspace — procure a new project</text>
      <text fg="#6b7280">────────────────────────────────────────</text>

      <box flexDirection="column" marginTop={1}>
        <text>
          <span fg="#f3f4f6">Product name: </span>
          <span fg={mode === 'name' ? '#fbbf24' : '#e5e7eb'}>{name || '(empty)'}</span>
          {mode === 'name' ? <span fg="#fbbf24">▎</span> : null}
        </text>
      </box>

      <box flexDirection="column" marginTop={1}>
        <text fg="#f3f4f6">Repos:</text>
        {repos.length === 0 ? (
          <text fg="#6b7280"> (none yet)</text>
        ) : (
          repos.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static list — order stable within a single TUI session
            <text key={i}>
              <span fg="#6b7280"> {String(i + 1).padStart(2)}. </span>
              <span
                fg={r.state === 'ok' ? '#4ade80' : r.state === 'pending' ? '#9ca3af' : '#f87171'}
              >
                {r.state === 'ok' ? '✓' : r.state === 'pending' ? '…' : '✗'}
              </span>
              <span fg="#e5e7eb"> {r.url}</span>
              {r.suggestion ? <span fg="#6b7280"> → try: {r.suggestion}</span> : null}
            </text>
          ))
        )}
        {mode === 'repos' ? (
          <text>
            <span fg="#fbbf24"> &gt; </span>
            <span fg="#fbbf24">{editBuffer}▎</span>
          </text>
        ) : null}
      </box>

      <box flexDirection="column" marginTop={1}>
        <text fg="#6b7280">{controlsForMode(mode, allValid)}</text>
        {hint ? <text fg="#f87171">{hint}</text> : null}
      </box>
    </box>
  );
}

function controlsForMode(mode: 'name' | 'repos' | 'review', allValid: boolean): string {
  if (mode === 'name') return '[type] name   [Enter] continue   [Esc] abort';
  if (mode === 'repos')
    return '[type] URL   [Enter] add (or continue if empty)   [Ctrl+D] remove last   [Ctrl+B] back   [Esc] abort';
  return allValid
    ? '[Enter] procure   [E] edit repos   [Ctrl+B] back   [Esc] abort'
    : 'Resolve repo errors before procuring   [E] edit repos   [Esc] abort';
}

export async function runTui(initial: TuiProps['initial']): Promise<ProcureSpec | null> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  return new Promise((resolveP) => {
    const handleSubmit = (spec: ProcureSpec) => {
      renderer.destroy();
      resolveP(spec);
    };
    const handleAbort = () => {
      renderer.destroy();
      resolveP(null);
    };
    createRoot(renderer).render(
      <App initial={initial} onSubmit={handleSubmit} onAbort={handleAbort} />,
    );
  });
}
