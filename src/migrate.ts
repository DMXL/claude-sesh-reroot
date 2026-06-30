import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { backupClaudeJson, backupProjectDir, timestamp } from "./backup.js";
import { rekeyClaudeJson } from "./config.js";
import { isInside } from "./files.js";
import { enumerateProjects, findSourceProjectDir, projectDirFor } from "./locate.js";
import { makeRewriter, rewriteTranscripts, type RewriteMode } from "./transcripts.js";

export interface MigrateOptions {
  inputDir: string;
  outputDir: string;
  /** "prefix" when files were relocated, "exact" for state-only. */
  mode: RewriteMode;
  dryRun: boolean;
  backup: boolean;
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
    if (cwd === inputDir || (mode === "prefix" && isInside(cwd, inputDir))) affected.set(dir, cwd);
  }
  const exact = findSourceProjectDir(inputDir);
  if (exact && !affected.has(exact)) affected.set(exact, inputDir);
  return [...affected].map(([dir, cwd]) => ({ dir, cwd }));
}

/** Perform the Claude-state migration (project session dirs, transcripts, config re-keying). */
export function migrateClaudeState(opts: MigrateOptions): MigrateSummary {
  const { inputDir, outputDir, mode, dryRun, backup, rewrite, force, verbose, log, warn } = opts;
  const vlog = (msg: string) => {
    if (verbose) log(msg);
  };
  const rewriter = makeRewriter(inputDir, outputDir, mode);
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
  for (const { dir, cwd } of projects) {
    const newCwd = rewriter(cwd);
    if (newCwd === cwd) continue;
    const dest = projectDirFor(newCwd);
    summary.movedProjects.push({ from: dir, to: dest });
    vlog(`${path(dir)} ${arrow} ${path(dest)}`);

    if (dryRun) continue;

    if (backup) vlog(pc.dim(`  backup: ${backupProjectDir(dir, ts)}`));
    const skipped = moveProjectDir(dir, dest, force);
    for (const s of skipped) {
      summary.skippedCollisions.push(`${dest}/${s}`);
      warn(`skipped existing ${s} (use --force to overwrite)`);
    }
    if (rewrite) {
      const r = rewriteTranscripts(dest, inputDir, outputDir, mode);
      summary.transcriptFiles += r.files;
      summary.transcriptLines += r.changedLines;
      if (r.files > 0) vlog(pc.dim(`  rewrote ${r.changedLines} line(s) across ${r.files} transcript(s)`));
    }
  }

  if (backup && !dryRun) {
    const bak = backupClaudeJson(ts);
    if (bak) vlog(pc.dim(`  backup: ${bak}`));
  }
  const cfg = rekeyClaudeJson(rewriter, dryRun);
  summary.rekeyed = cfg.rekeyed;
  summary.repoPathsUpdated = cfg.repoPathsUpdated;
  for (const r of cfg.rekeyed) {
    const [from, to] = r.split(" -> ");
    vlog(`${path(from)} ${arrow} ${path(to)}`);
  }

  return summary;
}
