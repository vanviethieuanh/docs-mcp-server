import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandError, GitCommandRunner } from "./GitCommandRunner";

const tmpDirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-gitrunner-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitCommandRunner", () => {
  it("runs git and captures stdout", async () => {
    const dir = tempRepo();
    const runner = new GitCommandRunner(dir);
    const result = await runner.run(["rev-parse", "--is-inside-work-tree"]);
    expect(result.stdout.trim()).toBe("true");
  });

  it("runs git scoped to a directory via runIn", async () => {
    const dir = tempRepo();
    const result = await new GitCommandRunner().runIn(dir, [
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(result.stdout.trim()).toBe(dir);
  });

  it("throws GitCommandError on non-zero exit", async () => {
    const dir = tempRepo();
    const runner = new GitCommandRunner(dir);
    await expect(runner.run(["this-command-does-not-exist"])).rejects.toThrow(
      GitCommandError,
    );
  });
});
