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
 * `rewrite` maps an old absolute path to its new location (exact or prefix
 * aware, supplied by the caller). Every `projects` key the rewrite changes is
 * moved (merging into any pre-existing destination key, destination wins), and
 * every `githubRepoPaths` checkout path is updated in place. When `dryRun` is
 * set nothing is written; the would-be changes are still reported.
 */
export function rekeyClaudeJson(rewrite: (s: string) => string, dryRun: boolean): ConfigResult {
  const path = claudeJsonPath();
  const result: ConfigResult = { rekeyed: [], repoPathsUpdated: 0 };
  if (!existsSync(path)) return result;

  const config = JSON.parse(readFileSync(path, "utf8")) as ClaudeJson;

  if (config.projects) {
    const projects = config.projects;
    for (const oldKey of Object.keys(projects)) {
      const newKey = rewrite(oldKey);
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
      const updated = paths.map((p) => (typeof p === "string" ? rewrite(p) : p));
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
