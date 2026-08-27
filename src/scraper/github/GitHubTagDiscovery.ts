import * as semver from "semver";
import type { GitCommandRunner } from "./GitCommandRunner";

/**
 * A single Git tag that represents a valid semantic version.
 */
export interface GitVersionTag {
  /** The exact Git tag name as it appears in the repository (e.g. `v1.2.3`). */
  tag: string;
  /** The normalized semantic version stored in the database (e.g. `1.2.3`). */
  version: string;
  /** The full commit hash the tag points to. */
  commit: string;
}

/**
 * Result of enumerating and normalizing a repository's semantic-version tags.
 */
export interface GitHubTagDiscoveryResult {
  /** Tags that are valid semantic versions, sorted descending. */
  versions: GitVersionTag[];
  /** Tag names that were skipped because they are not semantic versions. */
  ignored: string[];
}

/**
 * Thrown when two or more tags normalize to the same semantic version but
 * resolve to different commits. The database stores one document set per
 * version, so this collision cannot be represented safely.
 */
export class DuplicateVersionError extends Error {
  readonly version: string;
  readonly tags: string[];

  constructor(version: string, tags: string[]) {
    super(
      `Multiple Git tags resolve to the same semantic version "${version}" but ` +
        `point to different commits: ${tags.join(", ")}. ` +
        `Resolve the tag collision before indexing this repository.`,
    );
    this.name = "DuplicateVersionError";
    this.version = version;
    this.tags = tags;
  }
}

const SEMVER_TAG_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * Enumerates a repository's Git tags, keeps those that are valid semantic
 * versions (with or without a leading `v`), and normalizes their version
 * strings for database storage.
 */
export class GitHubTagDiscovery {
  private readonly git: GitCommandRunner;

  constructor(git: GitCommandRunner) {
    this.git = git;
  }

  /**
   * Resolves the tags of the repository rooted at the runner's working
   * directory.
   *
   * @returns The discovered semantic-version tags sorted descending.
   */
  async discover(): Promise<GitHubTagDiscoveryResult> {
    const tagResult = await this.git.run(["tag", "--list"]);
    const tags = tagResult.stdout
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);

    const ignored: string[] = [];
    const byVersion = new Map<string, GitVersionTag>();

    for (const tag of tags) {
      const match = SEMVER_TAG_RE.exec(tag);
      if (!match) {
        ignored.push(tag);
        continue;
      }
      const normalized = semver.valid(match[1]);
      if (!normalized) {
        ignored.push(tag);
        continue;
      }

      const commitResult = await this.git.run(["rev-parse", `${tag}^{commit}`]);
      const commit = commitResult.stdout.trim();

      const existing = byVersion.get(normalized);
      if (existing) {
        if (existing.commit !== commit) {
          throw new DuplicateVersionError(normalized, [existing.tag, tag]);
        }
        // Same commit: keep one entry.
        continue;
      }

      byVersion.set(normalized, { tag, version: normalized, commit });
    }

    const versions = [...byVersion.values()].sort((a, b) =>
      semver.compare(b.version, a.version),
    );
    return { versions, ignored };
  }
}
