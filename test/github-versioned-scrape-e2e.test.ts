/**
 * End-to-end tests for GitHub versioned scraping via direct Git streaming.
 *
 * The orchestrator clones the repository once, then for each semantic-version
 * tag streams the docs directory directly from Git (`git ls-tree` + `git show`)
 * into the pipeline. No `file://` URLs are used, so the file-access policy is
 * not involved. Each tag is stored as an independent library version.
 *
 * Uses a locally-created Git fixture repository (no network).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBusService } from "../src/events";
import { PipelineManager } from "../src/pipeline/PipelineManager";
import { ScraperRegistry, ScraperService } from "../src/scraper";
import { GitHubVersionedScrapeOrchestrator } from "../src/scraper/github/GitHubVersionedScrapeOrchestrator";
import { DocumentManagementService } from "../src/store/DocumentManagementService";
import { loadConfig, type AppConfig } from "../src/utils/config";

describe("GitHub versioned scrape (git streaming)", () => {
  let appConfig: AppConfig;
  let docService: DocumentManagementService;
  let pipeline: PipelineManager;
  let remote: string;

  beforeAll(async () => {
    remote = mkdtempSync(path.join(os.tmpdir(), "gitver-remote-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: remote });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: remote });
    execFileSync("git", ["config", "user.name", "T"], { cwd: remote });

    // v1.0.0 has docs/
    mkdirSync(path.join(remote, "docs"), { recursive: true });
    writeFileSync(path.join(remote, "docs", "index.md"), "# v1 docs");
    execFileSync("git", ["add", "-A"], { cwd: remote });
    execFileSync("git", ["commit", "-q", "-m", "v1"], { cwd: remote });
    execFileSync("git", ["tag", "v1.0.0"], { cwd: remote });

    // 2.0.0 has docs/ with an extra file
    writeFileSync(path.join(remote, "docs", "index.md"), "# v2 docs");
    writeFileSync(path.join(remote, "docs", "guide.md"), "# v2 guide");
    execFileSync("git", ["add", "-A"], { cwd: remote });
    execFileSync("git", ["commit", "-q", "-m", "v2"], { cwd: remote });
    execFileSync("git", ["tag", "2.0.0"], { cwd: remote });

    // 3.0.0 has no docs/ dir (remove it)
    writeFileSync(path.join(remote, "readme.md"), "# no docs here");
    execFileSync("git", ["rm", "-r", "-q", "docs"], { cwd: remote });
    execFileSync("git", ["add", "-A"], { cwd: remote });
    execFileSync("git", ["commit", "-q", "-m", "v3"], { cwd: remote });
    execFileSync("git", ["tag", "v3.0.0"], { cwd: remote });

    appConfig = loadConfig();
    appConfig.app.storePath = ":memory:";
    appConfig.app.embeddingModel = "";
    // Keep allowedRoots mode with an unresolvable root to prove no file access
    // is needed: the git-streaming strategy bypasses the filesystem entirely.
    appConfig.scraper.security.fileAccess.mode = "allowedRoots";
    appConfig.scraper.security.fileAccess.allowedRoots = ["$DOCUMENTS"];
    appConfig.scraper.security.fileAccess.includeHidden = false;
    appConfig.scraper.security.fileAccess.followSymlinks = false;
    appConfig.scraper.security.network.allowPrivateNetworks = true;

    const eventBus = new EventBusService();
    docService = new DocumentManagementService(eventBus, appConfig);
    await docService.initialize();
    const registry = new ScraperRegistry(appConfig);
    const scraper = new ScraperService(registry);
    pipeline = new PipelineManager(docService, eventBus, {
      recoverJobs: false,
      appConfig,
    });
    await pipeline.start();
  });

  afterAll(async () => {
    await pipeline.stop();
    await docService.shutdown();
    rmSync(remote, { recursive: true, force: true });
  });

  it("indexes each tag's docs as an independent version, skipping tags without docs", async () => {
    const orch = new GitHubVersionedScrapeOrchestrator(pipeline, appConfig);
    const res = await orch.run({
      library: "mylib",
      repositoryUrl: remote,
      docsSubpath: "docs",
    });

    expect(res.versionsDiscovered).toBe(3);
    expect(res.versionsIndexed).toBe(2);
    expect(res.versionsSkipped).toBe(1);

    const libs = await docService.listLibraries();
    const lib = libs.find((l) => l.library === "mylib");
    expect(lib).toBeDefined();

    const v1 = lib!.versions.find((x) => x.ref.version === "1.0.0");
    const v2 = lib!.versions.find((x) => x.ref.version === "2.0.0");
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();

    const v1Pages = v1 ? await docService.getPagesByVersionId(v1.id) : [];
    const v2Pages = v2 ? await docService.getPagesByVersionId(v2.id) : [];
    expect(v1Pages.length).toBe(1);
    expect(v2Pages.length).toBe(2);
  });

  it("honors tagFilter to index only a single tag", async () => {
    const orch = new GitHubVersionedScrapeOrchestrator(pipeline, appConfig);
    const res = await orch.run({
      library: "mylib2",
      repositoryUrl: remote,
      docsSubpath: "docs",
      tagFilter: "2.0.0",
    });

    expect(res.versionsDiscovered).toBe(3);
    expect(res.versionsIndexed).toBe(1);

    const libs = await docService.listLibraries();
    const lib = libs.find((l) => l.library === "mylib2");
    expect(lib!.versions.map((v) => v.ref.version)).toEqual(["2.0.0"]);
  });
});
