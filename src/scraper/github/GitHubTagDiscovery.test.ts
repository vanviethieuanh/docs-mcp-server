import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCommandRunner } from "./GitCommandRunner";
import { DuplicateVersionError, GitHubTagDiscovery } from "./GitHubTagDiscovery";

function createRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-mcp-tagtest-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "readme.md"), "# hello");
  return dir;
}

function commitTag(repo: string, tag: string, docsContent: string): void {
  const docsDir = path.join(repo, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, "readme.md"), docsContent);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", `release ${tag}`], { cwd: repo });
  execFileSync("git", ["tag", tag], { cwd: repo });
}

describe("GitHubTagDiscovery", async () => {
  it("discovers semantic tags with and without a leading v, sorted descending", async () => {
    const repo = createRepo();
    commitTag(repo, "v1.2.3", "one");
    commitTag(repo, "1.0.0", "two");
    commitTag(repo, "v2.0.0", "three");

    const git = new GitCommandRunner(repo);
    const discovery = new GitHubTagDiscovery(git);
    const { versions, ignored } = await discovery.discover();

    expect(versions.map((v) => v.version)).toEqual(["2.0.0", "1.2.3", "1.0.0"]);
    expect(versions.map((v) => v.tag)).toEqual(["v2.0.0", "v1.2.3", "1.0.0"]);
    expect(ignored).toEqual([]);

    rmSync(repo, { recursive: true, force: true });
  });

  it("ignores non-semantic tags", async () => {
    const repo = createRepo();
    commitTag(repo, "v1.2.3", "one");
    commitTag(repo, "latest", "two");
    commitTag(repo, "release-1", "three");

    const discovery = new GitHubTagDiscovery(new GitCommandRunner(repo));
    const { versions, ignored } = await discovery.discover();

    expect(versions.map((v) => v.version)).toEqual(["1.2.3"]);
    expect(ignored.sort()).toEqual(["latest", "release-1"].sort());

    rmSync(repo, { recursive: true, force: true });
  });

  it("includes prerelease tags and normalizes build metadata", async () => {
    const repo = createRepo();
    commitTag(repo, "v1.2.3-beta.1", "one");
    commitTag(repo, "v1.2.3+meta", "two");
    commitTag(repo, "1.1.0", "three");

    const discovery = new GitHubTagDiscovery(new GitCommandRunner(repo));
    const { versions } = await discovery.discover();

    // semver.valid strips build metadata, so v1.2.3+meta normalizes to 1.2.3.
    expect(versions.map((v) => v.version)).toEqual(["1.2.3", "1.2.3-beta.1", "1.1.0"]);

    rmSync(repo, { recursive: true, force: true });
  });

  it("deduplicates tags that point to the same commit", async () => {
    const repo = createRepo();
    commitTag(repo, "v1.2.3", "one");
    execFileSync("git", ["tag", "1.2.3"], { cwd: repo }); // same commit as v1.2.3

    const discovery = new GitHubTagDiscovery(new GitCommandRunner(repo));
    const { versions } = await discovery.discover();

    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("1.2.3");

    rmSync(repo, { recursive: true, force: true });
  });

  it("throws DuplicateVersionError when two tags normalize to the same version at different commits", async () => {
    const repo = createRepo();
    commitTag(repo, "v1.2.3", "one");
    commitTag(repo, "1.2.3", "different content");

    const discovery = new GitHubTagDiscovery(new GitCommandRunner(repo));
    await expect(discovery.discover()).rejects.toThrow(DuplicateVersionError);

    rmSync(repo, { recursive: true, force: true });
  });
});
