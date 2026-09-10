import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import pc from "picocolors";
import { backupClaudeJson, backupProjectDir, removeBackup, timestamp } from "./backup.js";
import { rekeyClaudeJson } from "./config.js";
import { encodeProjectDir } from "./encode.js";
import { isInside } from "./files.js";
import { enumerateProjects, findSourceProjectDir, projectDirFor } from "./locate.js";
import { makeRewriter, rewriteTranscripts, type RewriteMode } from "./transcripts.js";

export interface MigrateOptions {
  inputDir: string;
  /** Where the files moved to; also the default session root. */
  outputDir: string;
  /**
   * Where the session resumes from (`cd <sessionRoot> && claude --resume`).
   * Defaults to `outputDir`. Supply a different value to split the session root
   * from the files destination (e.g. resume from a hub while files live in a
   * subdirectory checkout).
   */
  sessionRoot?: string;
  /** "prefix" when files were relocated, "exact" for state-only. */
  mode: RewriteMode;
  dryRun: boolean;
  /** Take a crash-safety backup of each affected project dir before touching it. */
  backup: boolean;
  /** Keep those backups after a successful run instead of removing them. */
  keepBackups?: boolean;
  rewrite: boolean;
  force: boolean;
  verbose: boolean;
  /** Routine progress detail (only shown when verbose). */
  log: (msg: string) => void;
  /** Always-shown warnings. */
  warn: (msg: string) => void;
}

export interface MigrateSummary {
  movedProjects: Array<{ from: string; to: string }>;
  skippedCollisions: string[];
  transcriptFiles: number;
  transcriptLines: number;
  rekeyed: string[];
  repoPathsUpdated: number;
}

/** Move a project session dir, merging into an existing destination and reporting skipped collisions. */
function moveProjectDir(src: string, dest: string, force: boolean): string[] {
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        cpSync(src, dest, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return [];
  }

  const skipped: string[] = [];
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (existsSync(to)) {
      const isFile = statSync(from).isFile();
      if (isFile && !force) {
        skipped.push(entry);
        continue;
      }
      rmSync(to, { recursive: true, force: true });
    }
    try {
      renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }
  if (readdirSync(src).length === 0) rmSync(src, { recursive: true, force: true });
  return skipped;
}

/** Project session directories whose cwd is affected by the move. */
function affectedProjects(inputDir: string, mode: RewriteMode): Array<{ dir: string; cwd: string }> {
  const affected = new Map<string, string>();
  for (const { dir, cwd } of enumerateProjects()) {
    if (!(cwd === inputDir || (mode === "prefix" && isInside(cwd, inputDir)))) continue;
    // A project directory's name is the encoded form of its own cwd, but
    // enumerateProjects reads a cwd out of one arbitrary transcript, and a
    // directory can hold a transcript whose session has since moved: a session
    // started under inputDir and then re-rooted elsewhere (Claude Code's `/cd`)
    // keeps the old cwd in its first record while its transcript lives in the
    // new directory. Trusting that reading would claim the whole unrelated
    // directory and merge every session in it into the destination, so only
    // accept a directory whose name actually encodes the cwd it reported. The
    // exact source is added below regardless, and paths whose encoded form is
    // truncated past MAX_KEY_LENGTH are already unsupported.
    if (basename(dir) !== encodeProjectDir(cwd)) continue;
    affected.set(dir, cwd);
  }
  const exact = findSourceProjectDir(inputDir);
  if (exact && !affected.has(exact)) affected.set(exact, inputDir);
  return [...affected].map(([dir, cwd]) => ({ dir, cwd }));
}

/** A read-only forecast of what a migration would touch. */
export interface MigratePreview {
  /** Project session folders whose cwd identity changes. */
  sessionFolders: number;
  /** `.jsonl` transcripts across those folders. */
  transcriptFiles: number;
  /** `~/.claude.json` project keys that would be re-keyed. */
  configKeys: number;
  moves: Array<{ from: string; to: string; transcripts: number }>;
}

/**
 * Compute what a migration would move, changing nothing on disk. Uses the same
 * rewriters and enumeration as {@link migrateClaudeState}, so the counts match
 * what the real run will do.
 */
export function previewMigration(
  opts: Pick<MigrateOptions, "inputDir" | "outputDir" | "mode"> & { sessionRoot?: string },
): MigratePreview {
  const { inputDir, outputDir, mode } = opts;
  const sessionRoot = opts.sessionRoot ?? outputDir;
  const rewriter = makeRewriter(inputDir, outputDir, sessionRoot, mode);
  const filesRewriter = makeRewriter(inputDir, outputDir, outputDir, mode);

  const moves: MigratePreview["moves"] = [];
  for (const { dir, cwd } of affectedProjects(inputDir, mode)) {
    const newCwd = rewriter(cwd);
    if (newCwd === cwd) continue;
    let transcripts = 0;
    try {
      transcripts = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      // Unreadable dir; count as 0 transcripts.
    }
    moves.push({ from: dir, to: projectDirFor(newCwd), transcripts });
  }

  const cfg = rekeyClaudeJson(rewriter, filesRewriter, true);
  return {
    sessionFolders: moves.length,
    transcriptFiles: moves.reduce((n, m) => n + m.transcripts, 0),
    configKeys: cfg.rekeyed.length,
    moves,
  };
}

/** Perform the Claude-state migration (project session dirs, transcripts, config re-keying). */
export function migrateClaudeState(opts: MigrateOptions): MigrateSummary {
  const { inputDir, outputDir, mode, dryRun, backup, rewrite, force, verbose, log, warn } = opts;
  const filesDest = outputDir;
  const sessionRoot = opts.sessionRoot ?? outputDir;
  const keepBackups = opts.keepBackups ?? false;
  const vlog = (msg: string) => {
    if (verbose) log(msg);
  };
  // Project identity / cwd follows the session root; file paths follow the files
  // destination. `filesRewriter` sends the project root and everything under it
  // to the files destination, for entries (like repo checkout paths) that track
  // the files rather than the session root.
  const rewriter = makeRewriter(inputDir, filesDest, sessionRoot, mode);
  const filesRewriter = makeRewriter(inputDir, filesDest, filesDest, mode);
  const summary: MigrateSummary = {
    movedProjects: [],
    skippedCollisions: [],
    transcriptFiles: 0,
    transcriptLines: 0,
    rekeyed: [],
    repoPathsUpdated: 0,
  };

  const arrow = pc.dim("→");
  const path = (p: string) => pc.cyan(p);

  const projects = affectedProjects(inputDir, mode);
  if (projects.length === 0) {
    warn(`No Claude project sessions found for ${inputDir}.`);
  }

  const ts = timestamp();
  // Backups are a crash safety net taken before each mutation. If the run
  // completes we remove them (unless keepBackups); if it throws partway we keep
  // them and report where, so the half-migrated state can be recovered.
  const createdBackups: string[] = [];
  try {
    for (const { dir, cwd } of projects) {
      const newCwd = rewriter(cwd);
      if (newCwd === cwd) continue;
      const dest = projectDirFor(newCwd);
      summary.movedProjects.push({ from: dir, to: dest });
      vlog(`${path(dir)} ${arrow} ${path(dest)}`);

      if (dryRun) continue;

      if (backup) {
        const b = backupProjectDir(dir, ts);
        createdBackups.push(b);
        vlog(pc.dim(`  backup: ${b}`));
      }
      const skipped = moveProjectDir(dir, dest, force);
      for (const s of skipped) {
        summary.skippedCollisions.push(`${dest}/${s}`);
        warn(`skipped existing ${s} (use --force to overwrite)`);
      }
      if (rewrite) {
        const r = rewriteTranscripts(dest, inputDir, filesDest, sessionRoot, mode);
        summary.transcriptFiles += r.files;
        summary.transcriptLines += r.changedLines;
        if (r.files > 0) vlog(pc.dim(`  rewrote ${r.changedLines} line(s) across ${r.files} transcript(s)`));
      }
    }

    if (backup && !dryRun) {
      const bak = backupClaudeJson(ts);
      if (bak) {
        createdBackups.push(bak);
        vlog(pc.dim(`  backup: ${bak}`));
      }
    }
    const cfg = rekeyClaudeJson(rewriter, filesRewriter, dryRun);
    summary.rekeyed = cfg.rekeyed;
    summary.repoPathsUpdated = cfg.repoPathsUpdated;
    for (const r of cfg.rekeyed) {
      const [from, to] = r.split(" -> ");
      vlog(`${path(from)} ${arrow} ${path(to)}`);
    }
  } catch (err) {
    if (createdBackups.length > 0) {
      warn(`migration failed partway; ${createdBackups.length} backup(s) kept for recovery:`);
      for (const b of createdBackups) warn(`  ${b}`);
    }
    throw err;
  }

  // Success: the safety net is no longer needed.
  if (createdBackups.length > 0) {
    if (keepBackups) {
      vlog(pc.dim(`  kept ${createdBackups.length} backup(s)`));
    } else {
      for (const b of createdBackups) removeBackup(b);
      vlog(pc.dim(`  removed ${createdBackups.length} temporary backup(s)`));
    }
  }

  return summary;
}
