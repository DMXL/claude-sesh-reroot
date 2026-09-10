import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { claudeJsonPath } from "./locate.js";

interface ClaudeJson {
  projects?: Record<string, unknown>;
  githubRepoPaths?: Record<string, string[]>;
  [key: string]: unknown;
}

/** Shallow-merge two project config objects, preferring values already present at the destination. */
function mergeProjectEntries(existing: unknown, incoming: unknown): unknown {
  if (
    existing &&
    incoming &&
    typeof existing === "object" &&
    typeof incoming === "object" &&
    !Array.isArray(existing) &&
    !Array.isArray(incoming)
  ) {
    return { ...(incoming as object), ...(existing as object) };
  }
  return existing ?? incoming;
}

export interface ConfigResult {
  rekeyed: string[];
  repoPathsUpdated: number;
}

/**
 * Re-key path-dependent entries in `~/.claude.json`.
 *
 * Two rewriters are supplied because the two kinds of entry follow different
 * destinations when files and session root are split:
 *
 * - `rewriteKey` re-keys `projects` entries. A project key is a session
 *   identity, so it follows the session root (exact `inputDir` -> `sessionRoot`).
 * - `rewriteRepoPath` updates `githubRepoPaths` checkout paths. Those point at
 *   the actual files, so they follow the files destination (`inputDir` and
 *   anything under it -> `filesDest`).
 *
 * When the two destinations coincide the rewriters are identical. Every
 * `projects` key the rewrite changes is moved (merging into any pre-existing
 * destination key, destination wins). When `dryRun` is set nothing is written;
 * the would-be changes are still reported.
 */
export function rekeyClaudeJson(
  rewriteKey: (s: string) => string,
  rewriteRepoPath: (s: string) => string,
  dryRun: boolean,
): ConfigResult {
  const path = claudeJsonPath();
  const result: ConfigResult = { rekeyed: [], repoPathsUpdated: 0 };
  if (!existsSync(path)) return result;

  const config = JSON.parse(readFileSync(path, "utf8")) as ClaudeJson;

  if (config.projects) {
    const projects = config.projects;
    for (const oldKey of Object.keys(projects)) {
      const newKey = rewriteKey(oldKey);
      if (newKey === oldKey) continue;
      result.rekeyed.push(`${oldKey} -> ${newKey}`);
      if (!dryRun) {
        projects[newKey] = mergeProjectEntries(projects[newKey], projects[oldKey]);
        delete projects[oldKey];
      }
    }
  }

  if (config.githubRepoPaths) {
    for (const [repo, paths] of Object.entries(config.githubRepoPaths)) {
      if (!Array.isArray(paths)) continue;
      const updated = paths.map((p) => (typeof p === "string" ? rewriteRepoPath(p) : p));
      const changes = updated.filter((p, i) => p !== paths[i]).length;
      if (changes > 0) {
        result.repoPathsUpdated += changes;
        if (!dryRun) config.githubRepoPaths[repo] = updated;
      }
    }
  }

  const touched = result.rekeyed.length > 0 || result.repoPathsUpdated > 0;
  if (touched && !dryRun) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmp, path);
  }
  return result;
}
