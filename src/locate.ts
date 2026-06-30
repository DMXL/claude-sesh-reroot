import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { encodeProjectDir } from "./encode.js";

/** Root of Claude Code's per-user state, honoring CLAUDE_CONFIG_DIR. */
export function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsRoot(): string {
  return join(claudeRoot(), "projects");
}

export function claudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

export function backupsDir(): string {
  return join(claudeRoot(), "backups");
}

export function sessionsDir(): string {
  return join(claudeRoot(), "sessions");
}

/** The project session directory Claude Code would use for `absolutePath`. */
export function projectDirFor(absolutePath: string): string {
  return join(projectsRoot(), encodeProjectDir(absolutePath));
}

/** Read the authoritative top-level `cwd` from the first parseable line of a jsonl file. */
function firstRecordCwd(jsonlPath: string): string | undefined {
  try {
    const content = readFileSync(jsonlPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof record.cwd === "string") return record.cwd;
      } catch {
        // Skip non-JSON lines.
      }
    }
  } catch {
    // Unreadable file.
  }
  return undefined;
}

/**
 * Locate the project session directory for `inputDir`.
 *
 * Primary strategy: the deterministic encoded name. Fallback: scan every
 * project directory and match the authoritative `cwd` field recorded inside
 * its transcripts (robust against encoding edge cases such as truncation).
 * Returns the absolute directory path, or undefined if none is found.
 */
export function findSourceProjectDir(inputDir: string): string | undefined {
  const encoded = projectDirFor(inputDir);
  if (existsSync(encoded)) return encoded;

  const root = projectsRoot();
  if (!existsSync(root)) return undefined;

  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      if (firstRecordCwd(join(dir, file)) === inputDir) return dir;
    }
  }
  return undefined;
}

/** A discovered project session directory and its authoritative cwd. */
export interface ProjectEntry {
  dir: string;
  cwd: string;
}

/** Enumerate every project session directory along with the cwd recorded in its transcripts. */
export function enumerateProjects(): ProjectEntry[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const out: ProjectEntry[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const cwd = firstRecordCwd(join(dir, file));
      if (cwd) {
        out.push({ dir, cwd });
        break;
      }
    }
  }
  return out;
}

/**
 * Find any session files (`~/.claude/sessions/<pid>.json`) whose `cwd` matches
 * `inputDir`, indicating a live or recently-active session in that directory.
 */
export function activeSessionsFor(inputDir: string): Array<{ file: string; status?: string; name?: string }> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const matches: Array<{ file: string; status?: string; name?: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = join(dir, file);
    try {
      const data = JSON.parse(readFileSync(full, "utf8")) as {
        cwd?: string;
        status?: string;
        name?: string;
      };
      if (data.cwd === inputDir) matches.push({ file: full, status: data.status, name: data.name });
    } catch {
      // Ignore unparseable session files.
    }
  }
  return matches;
}
