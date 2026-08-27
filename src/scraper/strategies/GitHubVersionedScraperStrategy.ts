import type { ProgressCallback } from "../../types";
import type { AppConfig } from "../../utils/config";
import { ScraperError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import { FetchStatus, type RawContent } from "../fetcher/types";
import { GitCommandRunner } from "../github/GitCommandRunner";
import { PipelineFactory } from "../pipelines/PipelineFactory";
import type { ContentPipeline, PipelineResult } from "../pipelines/types";
import type { ScraperOptions, ScraperProgressEvent } from "../types";

/**
 * Versioned GitHub strategy.
 *
 * Unlike {@link GitHubScraperStrategy} (which crawls GitHub blob URLs over
 * HTTP), this strategy indexes a specific Git tag's documentation directory
 * directly from a local Git clone:
 *
 * 1. Uses the clone directory passed via `options.githubVersioned.repoDir`
 *    (shared by the orchestrator so the repo is cloned only once).
 * 2. Lists every file under the tag's `docs` subpath with `git ls-tree`.
 * 3. Streams each file's content with `git show <tag>:<path>`.
 * 4. Detects MIME, runs the standard pipelines, and reports each file as a
 *    scrape result (stored under the job's version).
 *
 * This avoids `file://` URLs entirely, so no file-access-policy or temporary
 * working-tree concerns apply to the indexed content.
 */
export class GitHubVersionedScraperStrategy {
  private readonly pipelines: ContentPipeline[];

  constructor(config: AppConfig) {
    this.pipelines = PipelineFactory.createStandardPipelines(config);
  }

  canHandle(url: string): boolean {
    return url.startsWith("github-version://");
  }

  async scrape(
    options: ScraperOptions,
    progressCallback: ProgressCallback<ScraperProgressEvent>,
    signal?: AbortSignal,
  ): Promise<void> {
    const versioned = options.githubVersioned;
    if (!versioned) {
      throw new ScraperError(
        `Missing githubVersioned options for versioned scrape.`,
        false,
      );
    }

    const { repoDir, tag, docsSubpath } = versioned;
    const git = new GitCommandRunner(repoDir);

    // List all files under the docs subpath for this tag.
    const listResult = await git.run(
      ["ls-tree", "-r", "--name-only", tag, "--", docsSubpath],
      { signal },
    );
    const files = listResult.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => !f.endsWith("/"));

    if (files.length === 0) {
      logger.info(`⏭️  No files under "${docsSubpath}/" for tag ${tag}.`);
    }

    logger.info(`📄 Indexing ${files.length} file(s) from ${tag} (${docsSubpath}/)`);

    let pagesScraped = 0;
    for (const file of files) {
      if (signal?.aborted) {
        throw new ScraperError(`Versioned scrape aborted for tag ${tag}.`, false);
      }

      const mimeType =
        MimeTypeUtils.detectMimeTypeFromPath(file) || "application/octet-stream";

      let contentBuffer: Buffer;
      try {
        const showResult = await git.run(["show", `${tag}:${file}`], { signal });
        contentBuffer = Buffer.from(showResult.stdout, "utf8");
      } catch (error) {
        // Binary files (images, etc.) may not round-trip through stdout as text.
        // Try again as raw bytes for binary documents.
        logger.warn(
          `⚠️  Failed to read "${file}" as text (${(error as Error).message}). Skipping.`,
        );
        continue;
      }

      const rawContent: RawContent = {
        source: `github-version://${docsSubpath}/${file}@${tag}`,
        content: contentBuffer,
        mimeType,
        status: FetchStatus.SUCCESS,
        lastModified: new Date().toISOString(),
      };

      const processed = await this.processContent(rawContent, file, options);

      pagesScraped += 1;
      await progressCallback({
        pagesScraped,
        totalPages: files.length,
        totalDiscovered: files.length,
        currentUrl: rawContent.source,
        depth: 0,
        maxDepth: 0,
        result: processed
          ? {
              url: rawContent.source,
              title: processed.title?.trim() || file,
              sourceContentType: rawContent.mimeType,
              contentType: processed.contentType || rawContent.mimeType,
              textContent: processed.textContent ?? "",
              links: processed.links ?? [],
              errors: processed.errors ?? [],
              chunks: processed.chunks ?? [],
            }
          : null,
      });
    }
  }

  private async processContent(
    rawContent: RawContent,
    file: string,
    options: ScraperOptions,
  ): Promise<PipelineResult | undefined> {
    for (const pipeline of this.pipelines) {
      if (pipeline.canProcess(rawContent.mimeType, rawContent.content)) {
        logger.debug(
          `Selected ${pipeline.constructor.name} for "${rawContent.mimeType}" (${file})`,
        );
        return pipeline.process(rawContent, options);
      }
    }
    logger.warn(`⚠️  Unsupported content type "${rawContent.mimeType}" for ${file}.`);
    return undefined;
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.pipelines.map((pipeline) => pipeline.close()));
  }
}
