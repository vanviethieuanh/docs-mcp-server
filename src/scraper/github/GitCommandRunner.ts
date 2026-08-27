import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Result of a successful Git invocation.
 */
export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Error thrown when a Git command exits with a non-zero status.
 */
export class GitCommandError extends Error {
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, code: number, stderr: string) {
    super(`git ${command} failed with exit code ${code}: ${stderr}`);
    this.name = "GitCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Thin, safe wrapper around `git` executed via `execFile`.
 *
 * Git arguments are passed as an array, never interpolated through a shell,
 * so repository/ref names cannot trigger command injection. Credentials are
 * never placed on the command line by this runner; callers must supply them
 * via environment variables or Git configuration instead.
 */
export class GitCommandRunner {
  private readonly cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  /**
   * Runs a single `git` command in the configured working directory.
   *
   * @param args - Arguments passed to `git` (e.g. `["tag", "--list"]`).
   * @param options - Optional execution controls.
   * @returns The captured stdout and stderr.
   */
  async run(
    args: string[],
    options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
  ): Promise<GitCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.cwd,
        signal: options.signal,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GitCommandError(
          args.join(" "),
          -1,
          "Git is not installed or not on PATH. Install Git to clone repositories.",
        );
      }
      const err = error as {
        code?: number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      if (err.killed) {
        throw new GitCommandError(args.join(" "), -1, "Git command was aborted.");
      }
      throw new GitCommandError(args.join(" "), err.code ?? 1, (err.stderr ?? "").trim());
    }
  }

  /**
   * Runs a `git` command scoped to a specific directory, overriding `cwd`.
   */
  async runIn(
    directory: string,
    args: string[],
    options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
  ): Promise<GitCommandResult> {
    return new GitCommandRunner(directory).run(args, options);
  }
}
