import { cpSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { backupsDir, claudeJsonPath } from "./locate.js";

/** A filesystem-safe timestamp like 2026-07-01T00-42-00-000Z. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Where project session backups live: under `~/.claude/backups/`, never in the scanned projects tree. */
export function projectBackupsDir(): string {
  return join(backupsDir(), "projects");
}

/**
 * Recursively copy a project session directory to
 * `~/.claude/backups/projects/<name>.bak-<ts>`. Kept out of `~/.claude/projects`
 * so Claude Code never scans it and migrations never re-enumerate it. Returns
 * the backup path.
 */
export function backupProjectDir(projectDir: string, ts: string): string {
  const dir = projectBackupsDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(projectDir)}.bak-${ts}`);
  cpSync(projectDir, dest, { recursive: true });
  return dest;
}

/** Remove a backup created during this run. Best-effort; never throws. */
export function removeBackup(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover backup is harmless.
  }
}

/** Copy `~/.claude.json` into `~/.claude/backups/`. Returns the backup path, or undefined if absent. */
export function backupClaudeJson(ts: string): string | undefined {
  const src = claudeJsonPath();
  if (!existsSync(src)) return undefined;
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `.claude.json.backup.${ts}`);
  copyFileSync(src, dest);
  return dest;
}
