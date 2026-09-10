#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { exceedsLimit } from "./encode.js";
import { applyFileStrategy, countFiles, determineFileStrategy, type FileStrategy } from "./files.js";
import { activeSessionsFor } from "./locate.js";
import { migrateClaudeState, previewMigration } from "./migrate.js";
import { confirm } from "./prompt.js";

interface Flags {
  dryRun: boolean;
  yes: boolean;
  stateOnly: boolean;
  rewrite: boolean;
  backup: boolean;
  keepBackups: boolean;
  force: boolean;
  verbose: boolean;
  /** Resume-from directory, when split from the files destination. */
  sessionRoot?: string;
}

const USAGE = `claude-sesh-reroot - re-home Claude Code sessions when a project folder moves

Usage:
  claude-sesh-reroot <input_dir> <output_dir> [options]

Migrates everything Claude Code keys to <input_dir> (project session transcripts
and ~/.claude.json entries) over to <output_dir>, so you can:

  cd <output_dir> && claude --resume

It also moves the project files on disk when that is unambiguous (auto-detected):
  - output_dir absent or empty  -> the folder is moved/renamed
  - output_dir non-empty         -> you are asked before merging
  - paths nested, or input_dir gone -> Claude state only, files untouched

By default you resume from output_dir. Pass --session-root to resume from a
different directory than the files landed in: files move to output_dir while the
session re-keys to <dir> (typically output_dir's parent, e.g. a workspace hub
whose subdirectory holds the checkout). Historical file paths still resolve into
output_dir.

Options:
  -n, --dry-run          Show what would happen; change nothing
  -y, --yes              Skip confirmation prompts
      --session-root <dir>  Resume from <dir> instead of output_dir (files still
                            move to output_dir)
      --state-only       Never move files; migrate Claude state only
      --no-rewrite       Do not rewrite path strings inside transcripts
      --no-backup        Skip the crash-safety backups entirely
      --keep-backups     Keep backups after a successful run (default: removed on success)
      --force            Overwrite collisions and proceed past safety checks
  -v, --verbose          Extra logging
  -h, --help             Show this help

Run it AFTER exiting the session you want to move.`;

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags; help: boolean } {
  const positionals: string[] = [];
  const flags: Flags = {
    dryRun: false,
    yes: false,
    stateOnly: false,
    rewrite: true,
    backup: true,
    keepBackups: false,
    force: false,
    verbose: false,
  };
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session-root" || arg.startsWith("--session-root=")) {
      const inline = arg.startsWith("--session-root=");
      const value = inline ? arg.slice("--session-root=".length) : argv[++i];
      if (!value) {
        console.error(pc.red("--session-root requires a directory argument"));
        process.exit(2);
      }
      flags.sessionRoot = value;
      continue;
    }
    switch (arg) {
      case "-n":
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--state-only":
        flags.stateOnly = true;
        break;
      case "--no-rewrite":
        flags.rewrite = false;
        break;
      case "--no-backup":
        flags.backup = false;
        break;
      case "--keep-backups":
        flags.keepBackups = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "-v":
      case "--verbose":
        flags.verbose = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(pc.red(`Unknown option: ${arg}`));
          process.exit(2);
        }
        positionals.push(arg);
    }
  }
  return { positionals, flags, help };
}

function fail(msg: string): never {
  console.error(pc.red(`error: ${msg}`));
  process.exit(1);
}

async function main(): Promise<void> {
  const { positionals, flags, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 2) {
    console.error(USAGE);
    process.exit(2);
  }

  const inputDir = resolve(positionals[0]);
  const outputDir = resolve(positionals[1]);
  const sessionRoot = flags.sessionRoot ? resolve(flags.sessionRoot) : outputDir;
  const splitRoot = sessionRoot !== outputDir;
  const vlog = (msg: string) => console.log(`  ${msg}`);
  const warn = (msg: string) => console.warn(pc.yellow(`! ${msg}`));

  if (inputDir === outputDir && !splitRoot) fail("input_dir and output_dir are the same path");
  if (sessionRoot === inputDir) fail("--session-root is the same as input_dir; the session would not be re-homed");
  if (exceedsLimit(inputDir) || exceedsLimit(outputDir) || exceedsLimit(sessionRoot)) {
    if (!flags.force) {
      fail(
        "encoded project name would exceed Claude Code's 200-char limit; the truncation hash " +
          "cannot be replicated, so resume would not find the session. Use --force to proceed anyway.",
      );
    }
    console.warn(pc.yellow("warning: encoded name exceeds 200 chars; resume may not find the session"));
  }

  // Decide what to do with the files on disk.
  const strategy: FileStrategy = flags.stateOnly
    ? { action: "state-only", reason: "forced via --state-only", filesMove: false, needsConfirm: false }
    : determineFileStrategy(inputDir, outputDir);
  const mode = strategy.filesMove ? "prefix" : "exact";

  // Preflight: show exactly what will change and get a single confirmation
  // before touching anything. Skipped for --dry-run (which only reports) and
  // bypassable with -y/--yes or --force.
  const active = activeSessionsFor(inputDir);
  const filesToMove = strategy.filesMove ? countFiles(inputDir) : 0;
  const preview = previewMigration({ inputDir, outputDir, sessionRoot, mode });
  // The directory you'll `cd` into to resume. It exists afterwards only if it
  // already exists, or the file move creates it (files land at the session root).
  const resumeWillExist = existsSync(sessionRoot) || (strategy.filesMove && sessionRoot === outputDir);

  if (!flags.dryRun) {
    const arrowP = pc.dim("→");
    const prow = (label: string, value: string) => console.log(`  ${pc.dim(label.padEnd(8))} ${value}`);
    console.log(pc.bold("About to re-home Claude sessions:"));
    prow("from", pc.cyan(inputDir));
    prow("to", pc.cyan(outputDir));
    if (splitRoot) prow("resume", pc.cyan(sessionRoot));
    prow(
      "files",
      strategy.filesMove
        ? `${filesToMove} file(s) ${arrowP} ${pc.cyan(outputDir)}`
        : pc.dim(`unchanged on disk (${strategy.reason})`),
    );
    prow(
      "sessions",
      `${preview.transcriptFiles} transcript(s) in ${preview.sessionFolders} project folder(s)`,
    );
    prow("config", `${preview.configKeys} ~/.claude.json entr${preview.configKeys === 1 ? "y" : "ies"}`);

    const warnings: string[] = [];
    if (preview.sessionFolders === 0) warnings.push(`no Claude sessions found for ${inputDir} — nothing to migrate`);
    if (!resumeWillExist)
      warnings.push(
        `resume target does not exist on disk: ${sessionRoot} ` +
          `(you won't be able to 'cd' there until you create it)`,
      );
    if (strategy.action === "merge-into-nonempty")
      warnings.push(`${outputDir} already exists and is not empty; existing files win unless --force`);
    if (active.length > 0)
      warnings.push(
        `${active.length} active session record(s) for ${inputDir} ` +
          `(e.g. "${active[0].name ?? "?"}", ${active[0].status ?? "?"}); exit that session first`,
      );
    for (const w of warnings) console.warn(pc.yellow(`! ${w}`));

    if (!flags.yes && !flags.force && !(await confirm("Proceed?"))) fail("aborted");
  }

  // Move files first so a failure aborts before any state is touched.
  if (!flags.dryRun && strategy.action !== "state-only") {
    try {
      applyFileStrategy(strategy, inputDir, outputDir, flags.force);
    } catch (err) {
      fail(`file move failed: ${(err as Error).message}`);
    }
  }

  const summary = migrateClaudeState({
    inputDir,
    outputDir,
    sessionRoot,
    mode,
    dryRun: flags.dryRun,
    backup: flags.backup,
    keepBackups: flags.keepBackups,
    rewrite: flags.rewrite,
    force: flags.force,
    verbose: flags.verbose,
    log: vlog,
    warn,
  });

  // Tidy summary.
  const arrow = pc.dim("→");
  const row = (label: string, value: string) => console.log(`  ${pc.dim(label.padEnd(8))} ${value}`);

  const filesValue =
    strategy.action === "state-only"
      ? `${pc.dim("unchanged on disk")} ${pc.dim(`(${strategy.reason})`)}`
      : strategy.action === "move-rename"
        ? `${pc.cyan(inputDir)} ${arrow} ${pc.cyan(outputDir)}`
        : `merged ${arrow} ${pc.cyan(outputDir)}`;

  const sessionsValue =
    summary.movedProjects.length === 0
      ? pc.yellow("none found")
      : `${summary.movedProjects.length} migrated` +
        (flags.verbose && summary.transcriptLines > 0
          ? pc.dim(` (${summary.transcriptLines} path line(s) rewritten)`)
          : "");

  const configParts: string[] = [];
  if (summary.rekeyed.length > 0) configParts.push(`${summary.rekeyed.length} project re-keyed`);
  if (summary.repoPathsUpdated > 0) configParts.push(`${summary.repoPathsUpdated} repo path(s) updated`);

  console.log();
  console.log(pc.bold(flags.dryRun ? "Dry run — no changes made" : "Done"));
  row("files", filesValue);
  row("sessions", sessionsValue);
  if (splitRoot) row("resume", pc.cyan(sessionRoot));
  row("config", configParts.length > 0 ? configParts.join(", ") : pc.dim("unchanged"));
  if (summary.skippedCollisions.length > 0) {
    row("skipped", pc.yellow(`${summary.skippedCollisions.length} collision(s) — re-run with --force to overwrite`));
  }

  console.log();
  console.log(pc.green(flags.dryRun ? "Would resume with:" : "Resume with:"));
  console.log(`  ${pc.bold(`cd ${sessionRoot} && claude --resume`)}`);
}

main().catch((err) => {
  console.error(pc.red(`error: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
