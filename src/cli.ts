#!/usr/bin/env node
import { resolve } from "node:path";
import pc from "picocolors";
import { exceedsLimit } from "./encode.js";
import { applyFileStrategy, determineFileStrategy, type FileStrategy } from "./files.js";
import { activeSessionsFor } from "./locate.js";
import { migrateClaudeState } from "./migrate.js";
import { confirm } from "./prompt.js";

interface Flags {
  dryRun: boolean;
  yes: boolean;
  stateOnly: boolean;
  rewrite: boolean;
  backup: boolean;
  force: boolean;
  verbose: boolean;
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

Options:
  -n, --dry-run     Show what would happen; change nothing
  -y, --yes         Skip confirmation prompts
      --state-only  Never move files; migrate Claude state only
      --no-rewrite  Do not rewrite path strings inside transcripts
      --no-backup   Do not create timestamped backups before changing things
      --force       Overwrite collisions and proceed past safety checks
  -v, --verbose     Extra logging
  -h, --help        Show this help

Run it AFTER exiting the session you want to move.`;

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags; help: boolean } {
  const positionals: string[] = [];
  const flags: Flags = {
    dryRun: false,
    yes: false,
    stateOnly: false,
    rewrite: true,
    backup: true,
    force: false,
    verbose: false,
  };
  let help = false;
  for (const arg of argv) {
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
  const vlog = (msg: string) => console.log(`  ${msg}`);
  const warn = (msg: string) => console.warn(pc.yellow(`! ${msg}`));

  if (inputDir === outputDir) fail("input_dir and output_dir are the same path");
  if (exceedsLimit(inputDir) || exceedsLimit(outputDir)) {
    if (!flags.force) {
      fail(
        "encoded project name would exceed Claude Code's 200-char limit; the truncation hash " +
          "cannot be replicated, so resume would not find the session. Use --force to proceed anyway.",
      );
    }
    console.warn(pc.yellow("warning: encoded name exceeds 200 chars; resume may not find the session"));
  }

  // Preflight: warn about a session that may still be active in input_dir.
  const active = activeSessionsFor(inputDir);
  if (active.length > 0 && !flags.force && !flags.dryRun) {
    console.warn(
      pc.yellow(
        `warning: found ${active.length} session record(s) for ${inputDir} ` +
          `(e.g. "${active[0].name ?? "?"}", status ${active[0].status ?? "?"}).`,
      ),
    );
    console.warn(pc.yellow("If that session is still running, exit it first so it doesn't rewrite the old location."));
    if (!flags.yes && !(await confirm("Continue anyway?"))) fail("aborted");
  }

  // Decide what to do with the files on disk.
  let strategy: FileStrategy = flags.stateOnly
    ? { action: "state-only", reason: "forced via --state-only", filesMove: false, needsConfirm: false }
    : determineFileStrategy(inputDir, outputDir);

  if (strategy.needsConfirm && !flags.dryRun && !flags.yes && !flags.force) {
    if (!(await confirm(`${pc.cyan(outputDir)} is not empty. Merge ${pc.cyan(inputDir)} into it?`))) {
      strategy = { action: "state-only", reason: "merge declined", filesMove: false, needsConfirm: false };
    }
  }

  const mode = strategy.filesMove ? "prefix" : "exact";

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
    mode,
    dryRun: flags.dryRun,
    backup: flags.backup,
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
  row("config", configParts.length > 0 ? configParts.join(", ") : pc.dim("unchanged"));
  if (summary.skippedCollisions.length > 0) {
    row("skipped", pc.yellow(`${summary.skippedCollisions.length} collision(s) — re-run with --force to overwrite`));
  }

  console.log();
  console.log(pc.green(flags.dryRun ? "Would resume with:" : "Resume with:"));
  console.log(`  ${pc.bold(`cd ${outputDir} && claude --resume`)}`);
}

main().catch((err) => {
  console.error(pc.red(`error: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
