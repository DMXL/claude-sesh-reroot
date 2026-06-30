import { cpSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backupsDir, claudeJsonPath } from "./locate.js";

/** A filesystem-safe timestamp like 2026-07-01T00-42-00-000Z. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Recursively copy a project directory to a sibling `<dir>.bak-<ts>`. Returns the backup path. */
export function backupProjectDir(projectDir: string, ts: string): string {
  const dest = join(dirname(projectDir), `${basename(projectDir)}.bak-${ts}`);
  cpSync(projectDir, dest, { recursive: true });
  return dest;
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
