/**
 * Shared types for the workspace-cli procurement flow.
 *
 * Naming convention:
 *   - `RepoSpec` mirrors `SpawnRepoSpec` from @agentx/harness-server but is
 *     declared locally to avoid a tight coupling with the spawn primitive's
 *     evolution. The shape MUST stay structurally compatible with
 *     SpawnRepoSpec — validateRepoAccess + harness-workspace.yml substitution
 *     both rely on it.
 */

export interface RepoSpec {
  /** Short repo name; becomes the local clone directory name + the
   *  per-product key in harness-workspace.yml. Derived from the URL's
   *  basename when not explicitly set. */
  name: string;
  /** Full clone URL (HTTPS or SSH). */
  cloneUrl: string;
  /** Optional default branch. Falls back to repo's HEAD at validation time. */
  baseRef?: string;
}

export interface ProcureSpec {
  /** The product name; doubles as the workspace directory name and the
   *  product id in harness-workspace.yml unless `dest` is overridden. */
  name: string;
  /** Repos to clone into the new workspace + register in the yml. */
  repos: RepoSpec[];
  /** Destination directory. Defaults to `./<name>`. */
  dest: string;
  /** Env-var name holding a GitHub token for HTTPS clones. SSH URLs use
   *  ssh-agent and ignore this. */
  tokenEnv?: string;
  /** Skip the eager-clone step (for dry-run / advanced flows where the
   *  user wants to populate working trees themselves). */
  noClone?: boolean;
}

export interface ProcureResult {
  ok: boolean;
  /** Absolute path to the procured project. Set on both success and
   *  failure (so the user can inspect partial state when applicable). */
  projectDir: string;
  /** Per-repo clone outcomes. */
  repos: Array<{
    repo: RepoSpec;
    cloned: boolean;
    /** Resolved HEAD SHA on success. */
    head?: string;
    /** Failure reason on `cloned: false`. */
    reason?: string;
  }>;
  /** Generated absolute paths (set on success only). */
  workspaceFile?: string;
  configFile?: string;
}
