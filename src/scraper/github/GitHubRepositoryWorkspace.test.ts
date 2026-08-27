import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubRepositoryWorkspace } from "./GitHubRepositoryWorkspace";

const tmpDirs: string[] = [];

function makeRepo(workDir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  writeFileSync(path.join(workDir, "readme.md"), "# repo");
  execFileSync("git", ["add", "-A"], { cwd: workDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: workDir });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitHubRepositoryWorkspace", () => {
  it("creates a temp workspace and clones into it", async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-remote-"));
    tmpDirs.push(remote);
    makeRepo(remote);

    const ws = new GitHubRepositoryWorkspace();
    tmpDirs.push(ws.rootDir);

    await ws.clone(remote, { env: { GIT_ALLOW_PROTOCOL: "file" } });
    expect(existsSync(path.join(ws.workDir, "readme.md"))).toBe(true);
  });

  it("resolves a docs subpath and cleans up on cleanup", async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-remote-"));
    tmpDirs.push(remote);
    makeRepo(remote);
    mkdirSync(path.join(remote, "docs"), { recursive: true });
    writeFileSync(path.join(remote, "docs", "intro.md"), "# intro");
    execFileSync("git", ["add", "-A"], { cwd: remote });
    execFileSync("git", ["commit", "-q", "-m", "add docs"], { cwd: remote });

    const ws = new GitHubRepositoryWorkspace();
    tmpDirs.push(ws.rootDir);

    await ws.clone(remote, { env: { GIT_ALLOW_PROTOCOL: "file" } });
    const docs = await ws.resolveSubpath("docs");
    expect(docs).toBeTruthy();
    expect(existsSync(path.join(ws.rootDir, "repository", "docs"))).toBe(true);

    await ws.cleanup();
    expect(existsSync(ws.rootDir)).toBe(false);
  });

  it("returns null for a missing subpath", async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-remote-"));
    tmpDirs.push(remote);
    makeRepo(remote);

    const ws = new GitHubRepositoryWorkspace();
    tmpDirs.push(ws.rootDir);

    await ws.clone(remote, { env: { GIT_ALLOW_PROTOCOL: "file" } });
    expect(await ws.resolveSubpath("does-not-exist")).toBeNull();
  });

  it("retains the workspace when keepWorkspace is true", async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-remote-"));
    tmpDirs.push(remote);
    makeRepo(remote);

    const ws = new GitHubRepositoryWorkspace({ keepWorkspace: true });
    tmpDirs.push(ws.rootDir);

    await ws.clone(remote, { env: { GIT_ALLOW_PROTOCOL: "file" } });
    await ws.cleanup();
    expect(existsSync(ws.rootDir)).toBe(true);
    expect(ws.isKept).toBe(true);
  });
});
