import type { IPipeline } from "../../pipeline/trpc/interfaces";
import type { AppConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { ScrapeMode } from "../types";
import { GitHubRepositoryWorkspace } from "./GitHubRepositoryWorkspace";
import { GitHubTagDiscovery, type GitVersionTag } from "./GitHubTagDiscovery";

export interface GitHubVersionedScrapeResult {
  /** Repository URL that was cloned. */
  repositoryUrl: string;
  /** Total semantic-version tags discovered. */
  versionsDiscovered: number;
  /** Versions successfully indexed. */
  versionsIndexed: number;
  /** Versions skipped (no docs subpath). */
  versionsSkipped: number;
  /** Versions that failed to index. */
  versionsFailed: number;
  /** Per-version outcomes. */
  versions: Array<{
    version: string;
    tag: string;
    status: "indexed" | "skipped" | "failed";
    pagesScraped: number;
  }>;
  /** Tags ignored because they are not semantic versions. */
  ignoredTags: string[];
}

export interface GitHubVersionedScrapeOptions {
  /** The library name versions are stored under. */
  library: string;
  /** GitHub repository URL to clone. */
  repositoryUrl: string;
  /** Subpath within each tag to index (defaults to config docsSubpath). */
  docsSubpath?: string;
  /** Retain the workspace after completion for debugging. */
  keepWorkspace?: boolean;
  /** Custom include patterns relative to the repository root. */
  includePatterns?: string[];
  /** Custom exclude patterns. */
  excludePatterns?: string[];
  /** If provided, only check out this single tag instead of all versions. */
  tagFilter?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Clones a GitHub repository, enumerates its semantic-version tags, checks out
 * each tag sequentially, and indexes the requested docs subpath of every tag as
 * an independent library version.
 *
 * This runs in the calling process (which owns the temporary checkout) and
 * delegates per-version indexing to the existing pipeline, so version-scoped
 * storage, strategy selection, and cleanup are all reused.
 */
export class GitHubVersionedScrapeOrchestrator {
  private readonly pipeline: IPipeline;
  private readonly config: AppConfig;

  constructor(pipeline: IPipeline, config?: AppConfig) {
    this.pipeline = pipeline;
    this.config = config ?? ({ scraper: {} } as AppConfig);
  }

  private githubVersioned() {
    return (
      this.config.scraper.github?.versionedScrape ?? {
        enabled: false,
        keepWorkspace: false,
        docsSubpath: "docs",
      }
    );
  }

  /**
   * Runs a versioned GitHub scrape to completion.
   */
  async run(options: GitHubVersionedScrapeOptions): Promise<GitHubVersionedScrapeResult> {
    const {
      library,
      repositoryUrl,
      docsSubpath = this.githubVersioned().docsSubpath,
      keepWorkspace = this.githubVersioned().keepWorkspace,
      includePatterns,
      excludePatterns,
      tagFilter,
      signal,
    } = options;

    const workspace = new GitHubRepositoryWorkspace({ keepWorkspace });
    const result: GitHubVersionedScrapeResult = {
      repositoryUrl,
      versionsDiscovered: 0,
      versionsIndexed: 0,
      versionsSkipped: 0,
      versionsFailed: 0,
      versions: [],
      ignoredTags: [],
    };

    try {
      logger.info(`🚀 Cloning GitHub repository ${repositoryUrl} for versioned scrape`);
      await workspace.clone(repositoryUrl, { signal });

      const discovery = new GitHubTagDiscovery(workspace.git);
      const { versions, ignored } = await discovery.discover();
      result.ignoredTags = ignored;
      result.versionsDiscovered = versions.length;

      if (versions.length === 0) {
        logger.warn(
          `⚠️  No semantic-version tags found in ${repositoryUrl}; nothing to index.`,
        );
        return result;
      }

      const tagsToProcess = tagFilter
        ? versions.filter((v) => v.tag === tagFilter || v.version === tagFilter)
        : versions;
      if (tagFilter && tagsToProcess.length === 0) {
        logger.warn(`⚠️  Tag filter "${tagFilter}" matched no semantic-version tags.`);
      }

      logger.info(
        `🔎 Discovered ${versions.length} semantic-version tags; processing ${tagsToProcess.length}.`,
      );

      for (const version of tagsToProcess) {
        if (signal?.aborted) {
          logger.warn(`🛑 Versioned scrape aborted before ${version.version}.`);
          break;
        }
        await this.processVersion(
          workspace,
          version,
          library,
          docsSubpath,
          { includePatterns, excludePatterns },
          result,
          signal,
        );
      }

      return result;
    } finally {
      const kept = workspace.isKept;
      await workspace.cleanup();
      if (kept) {
        logger.info(`🧪 Workspace retained for debugging at ${workspace.rootDir}`);
      }
    }
  }

  private async processVersion(
    workspace: GitHubRepositoryWorkspace,
    version: GitVersionTag,
    library: string,
    docsSubpath: string,
    filters: { includePatterns?: string[]; excludePatterns?: string[] },
    result: GitHubVersionedScrapeResult,
    signal?: AbortSignal,
  ): Promise<void> {
    const { tag, version: normalizedVersion } = version;
    try {
      // Detect whether the tag actually has the docs subpath before enqueueing.
      const treeResult = await workspace.git.run(["ls-tree", tag, "--", docsSubpath], {
        signal,
      });
      if (treeResult.stdout.trim() === "") {
        logger.info(`⏭️  Skipping ${normalizedVersion} (no "${docsSubpath}/" directory).`);
        result.versionsSkipped += 1;
        result.versions.push({
          version: normalizedVersion,
          tag,
          status: "skipped",
          pagesScraped: 0,
        });
        return;
      }

      const docsUrl = `github-version://${docsSubpath}@${tag}`;
      logger.info(`📖 Indexing ${library}@${normalizedVersion} (tag ${tag}) from Git`);

      const jobId = await this.pipeline.enqueueScrapeJob(library, normalizedVersion, {
        url: docsUrl,
        library,
        version: normalizedVersion,
        scope: "subpages",
        followRedirects: true,
        maxPages: this.config.scraper.maxPages ?? 1000,
        maxDepth: this.config.scraper.maxDepth ?? 3,
        maxConcurrency: this.config.scraper.maxConcurrency ?? 3,
        ignoreErrors: true,
        scrapeMode: ScrapeMode.Auto,
        excludePatterns: filters.excludePatterns,
        clean: true,
        githubVersioned: {
          repoDir: workspace.workDir,
          tag,
          docsSubpath,
        },
      });

      await this.pipeline.waitForJobCompletion(jobId);
      const job = await this.pipeline.getJob(jobId);
      const pagesScraped = job?.progress?.pagesScraped ?? 0;

      result.versionsIndexed += 1;
      result.versions.push({
        version: normalizedVersion,
        tag,
        status: "indexed",
        pagesScraped,
      });
    } catch (error) {
      logger.error(
        `❌ Failed to index ${library}@${normalizedVersion} (tag ${tag}): ${error}`,
      );
      result.versionsFailed += 1;
      result.versions.push({
        version: normalizedVersion,
        tag,
        status: "failed",
        pagesScraped: 0,
      });
    }
  }
}
