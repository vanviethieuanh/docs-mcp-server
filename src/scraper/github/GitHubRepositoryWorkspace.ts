import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitCommandRunner } from "./GitCommandRunner";

export interface GitHubRepositoryWorkspaceOptions {
  /** Working tree for the cloned repository. */
  workDir: string;
  /** Root directory hosting the workspace (parent of the clone). */
  rootDir: string;
  /** Whether to retain the workspace on cleanup (debugging). */
  keepWorkspace: boolean;
}

/**
 * Manages a temporary, self-cleaning clone of a GitHub repository.
 *
 * Layout:
 * ```
 * <rootDir>/
 *   repository/       # the Git clone (bare-less working tree)
 *   docs/             # (not created here; resolved from the clone)
 * ```
 *
 * The workspace lives under `os.tmpdir()` and is removed recursively on
 * cleanup unless `keepWorkspace` is enabled for debugging.
 */
export class GitHubRepositoryWorkspace {
  readonly rootDir: string;
  readonly workDir: string;
  readonly git: GitCommandRunner;
  private readonly keepWorkspace: boolean;
  private cleaned = false;

  /** Whether the workspace will be retained after cleanup. */
  get isKept(): boolean {
    return this.keepWorkspace;
  }

  constructor(options?: Partial<GitHubRepositoryWorkspaceOptions>) {
    this.keepWorkspace = options?.keepWorkspace ?? false;
    // Resolve lazily so tests can construct with explicit dirs; otherwise
    // default to a freshly created temp dir.
    if (options?.rootDir && options?.workDir) {
      this.rootDir = options.rootDir;
      this.workDir = options.workDir;
    } else {
      this.rootDir = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-github-"));
      this.workDir = path.join(this.rootDir, "repository");
    }
    this.git = new GitCommandRunner(this.workDir);
  }

  /**
   * Clones the repository into the workspace. Returns the local working tree.
   */
  async clone(
    url: string,
    options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
  ): Promise<string> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const runner = new GitCommandRunner(this.rootDir);
    // Full clone (not shallow) so every tag can be checked out later.
    await runner.run(
      ["clone", "--quiet", "--no-tags", url, path.basename(this.workDir)],
      { signal: options.signal, env: options.env },
    );
    // Fetch all tags explicitly so annotated tags resolve to commits.
    await this.git.run(["fetch", "--tags", "--force"], {
      signal: options.signal,
    });
    return this.workDir;
  }

  /**
   * Checks out the given tag (detached) into the working tree.
   */
  async checkout(tag: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.git.run(["checkout", "--quiet", "--detach", tag], {
      signal: options.signal,
    });
  }

  /**
   * Resolves the `docs` directory of the current checkout.
   *
   * @returns The absolute path to the docs directory, or `null` if absent.
   */
  async resolveSubpath(subpath: string): Promise<string | null> {
    const dir = path.resolve(this.workDir, subpath);
    try {
      const stats = await fs.stat(dir);
      return stats.isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes the workspace recursively. Safe to call multiple times.
   */
  async cleanup(): Promise<void> {
    if (this.cleaned) {
      return;
    }
    this.cleaned = true;
    if (this.keepWorkspace) {
      return;
    }
    await fs.rm(this.rootDir, { recursive: true, force: true }).catch(() => {});
  }
}
