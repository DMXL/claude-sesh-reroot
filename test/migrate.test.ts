import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeProjectDir } from "../src/encode.js";
import { migrateClaudeState, previewMigration } from "../src/migrate.js";

interface Fixture {
  home: string;
  projectsRoot: string;
  claudeJson: string;
}

function setupHome(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "csr-test-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  const projectsRoot = join(home, ".claude", "projects");
  mkdirSync(projectsRoot, { recursive: true });
  return { home, projectsRoot, claudeJson: join(home, ".claude.json") };
}

function writeJsonl(dir: string, sessionId: string, records: object[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function readJsonl(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("rename (prefix mode) moves project dir, rewrites transcripts, re-keys config", () => {
  const fx = setupHome();
  const inputDir = "/work/old-proj";
  const outputDir = "/work/new-proj";

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [
    { type: "user", cwd: inputDir, gitBranch: "main" },
    { type: "assistant", cwd: inputDir, note: `${inputDir}/src/index.ts edited` },
    { type: "assistant", cwd: inputDir, note: "/unrelated/path stays" },
  ]);

  writeFileSync(
    fx.claudeJson,
    JSON.stringify({
      projects: {
        [inputDir]: { allowedTools: ["Read"], lastSessionId: "sess1" },
        "/other/proj": { allowedTools: [] },
      },
      githubRepoPaths: { "dmxl/old-proj": [inputDir, "/other/proj"] },
    }),
  );

  const summary = migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: false,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  const destDir = join(fx.projectsRoot, encodeProjectDir(outputDir));
  assert.equal(existsSync(srcDir), false, "source project dir removed");
  assert.equal(existsSync(destDir), true, "dest project dir created");
  assert.equal(summary.movedProjects.length, 1);

  const records = readJsonl(join(destDir, "sess1.jsonl"));
  assert.equal(records[0].cwd, outputDir, "cwd rewritten");
  assert.equal(records[1].note, `${outputDir}/src/index.ts edited`, "prefix path rewritten");
  assert.equal(records[2].note, "/unrelated/path stays", "unrelated path untouched");

  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[outputDir], "new key present");
  assert.equal(cfg.projects[inputDir], undefined, "old key removed");
  assert.equal(cfg.projects[outputDir].lastSessionId, "sess1", "config value preserved");
  assert.deepEqual(cfg.githubRepoPaths["dmxl/old-proj"], [outputDir, "/other/proj"], "repo path updated");
});

test("split session root: cwd -> sessionRoot, file paths -> filesDest", () => {
  const fx = setupHome();
  const inputDir = "/old/proj";
  const filesDest = "/hub/repo"; // outputDir: where files land
  const sessionRoot = "/hub"; // resume from here (parent of the checkout)

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [
    { type: "user", cwd: inputDir },
    { type: "assistant", cwd: inputDir, note: `${inputDir}/src/index.ts edited` },
    { type: "assistant", cwd: inputDir, note: "/unrelated stays" },
  ]);

  writeFileSync(
    fx.claudeJson,
    JSON.stringify({
      projects: { [inputDir]: { lastSessionId: "sess1" } },
      githubRepoPaths: { "dmxl/proj": [inputDir] },
    }),
  );

  migrateClaudeState({
    inputDir,
    outputDir: filesDest,
    sessionRoot,
    mode: "prefix",
    dryRun: false,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  // Session dir is keyed to the session root, not the files destination.
  const destDir = join(fx.projectsRoot, encodeProjectDir(sessionRoot));
  assert.equal(existsSync(destDir), true, "session dir keyed to sessionRoot");
  assert.equal(existsSync(join(fx.projectsRoot, encodeProjectDir(filesDest))), false, "not keyed to filesDest");

  const records = readJsonl(join(destDir, "sess1.jsonl"));
  assert.equal(records[0].cwd, sessionRoot, "cwd -> sessionRoot");
  assert.equal(records[1].note, `${filesDest}/src/index.ts edited`, "nested file path -> filesDest");
  assert.equal(records[2].note, "/unrelated stays", "unrelated path untouched");

  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[sessionRoot], "project key -> sessionRoot");
  assert.equal(cfg.projects[inputDir], undefined, "old project key removed");
  assert.deepEqual(cfg.githubRepoPaths["dmxl/proj"], [filesDest], "repo checkout path -> filesDest");
});

test("nested state-only (exact mode) rewrites only the cwd identity", () => {
  const fx = setupHome();
  const inputDir = "/root";
  const outputDir = "/root/A";

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [
    { type: "user", cwd: inputDir },
    { type: "assistant", cwd: inputDir, note: "/root/A/foo should not double up" },
  ]);

  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: { lastSessionId: "sess1" } } }));

  migrateClaudeState({
    inputDir,
    outputDir,
    mode: "exact",
    dryRun: false,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  const destDir = join(fx.projectsRoot, encodeProjectDir(outputDir));
  const records = readJsonl(join(destDir, "sess1.jsonl"));
  assert.equal(records[0].cwd, outputDir, "exact cwd rewritten");
  assert.equal(records[1].note, "/root/A/foo should not double up", "deeper path left intact in exact mode");

  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[outputDir]);
  assert.equal(cfg.projects[inputDir], undefined);
});

test("ignores the tool's own .bak- backup dirs when enumerating sources", () => {
  const fx = setupHome();
  const inputDir = "/work/proj";
  const outputDir = "/work/moved";

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [{ type: "user", cwd: inputDir }]);
  // A leftover backup carrying the SAME recorded cwd as the live project.
  const bakDir = srcDir + ".bak-2026-01-01T00-00-00-000Z";
  writeJsonl(bakDir, "sess1", [{ type: "user", cwd: inputDir }]);

  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {} } }));

  const summary = migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: false,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  assert.equal(summary.movedProjects.length, 1, "only the live project moved, not the backup");
  assert.equal(summary.skippedCollisions.length, 0, "no collisions from a phantom backup source");
  assert.equal(existsSync(bakDir), true, "backup dir left untouched");
  assert.equal(existsSync(join(fx.projectsRoot, encodeProjectDir(outputDir))), true, "dest created");
});

test("previewMigration counts folders, transcripts and config keys with no side effects", () => {
  const fx = setupHome();
  const inputDir = "/work/prev-old";
  const outputDir = "/work/prev-new";

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [{ type: "user", cwd: inputDir }]);
  writeJsonl(srcDir, "sess2", [{ type: "user", cwd: inputDir }]);
  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {}, "/other": {} } }));

  const preview = previewMigration({ inputDir, outputDir, mode: "prefix" });
  assert.equal(preview.sessionFolders, 1, "one project folder affected");
  assert.equal(preview.transcriptFiles, 2, "both transcripts counted");
  assert.equal(preview.configKeys, 1, "only the matching config key counted");

  // No side effects.
  assert.equal(existsSync(srcDir), true, "source untouched");
  assert.equal(existsSync(join(fx.projectsRoot, encodeProjectDir(outputDir))), false, "dest not created");
  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[inputDir], "config key left in place");
});

test("previewMigration reports nothing when the input has no sessions", () => {
  const fx = setupHome();
  writeFileSync(fx.claudeJson, JSON.stringify({ projects: {} }));
  const preview = previewMigration({ inputDir: "/work/ghost", outputDir: "/work/ghost-new", mode: "prefix" });
  assert.equal(preview.sessionFolders, 0);
  assert.equal(preview.transcriptFiles, 0);
  assert.equal(preview.configKeys, 0);
});

test("removes backups after a successful run and never writes them into the projects tree", () => {
  const fx = setupHome();
  const inputDir = "/work/proj";
  const outputDir = "/work/moved";
  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [{ type: "user", cwd: inputDir }]);
  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {} } }));

  migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: false,
    backup: true,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  // The migration happened...
  assert.equal(existsSync(join(fx.projectsRoot, encodeProjectDir(outputDir))), true, "dest created");
  // ...no backup was left in the scanned projects tree...
  assert.equal(
    readdirSync(fx.projectsRoot).some((e) => e.includes(".bak-")),
    false,
    "no .bak in projects tree",
  );
  // ...and the relocated backup was cleaned up on success.
  const backupsProjects = join(fx.home, ".claude", "backups", "projects");
  const leftover = existsSync(backupsProjects) ? readdirSync(backupsProjects) : [];
  assert.deepEqual(leftover, [], "no leftover project backups after success");
});

test("--keep-backups retains the snapshot under ~/.claude/backups/projects", () => {
  const fx = setupHome();
  const inputDir = "/work/proj";
  const outputDir = "/work/moved";
  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [{ type: "user", cwd: inputDir }]);
  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {} } }));

  migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: false,
    backup: true,
    keepBackups: true,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  const backupsProjects = join(fx.home, ".claude", "backups", "projects");
  const kept = existsSync(backupsProjects) ? readdirSync(backupsProjects) : [];
  assert.equal(kept.length, 1, "one project backup kept");
  assert.ok(kept[0].includes(".bak-"), "named as a backup");
  assert.equal(
    readdirSync(fx.projectsRoot).some((e) => e.includes(".bak-")),
    false,
    "still not polluting the projects tree",
  );
});

test("dry-run changes nothing on disk", () => {
  const fx = setupHome();
  const inputDir = "/work/dry-old";
  const outputDir = "/work/dry-new";
  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "sess1", [{ type: "user", cwd: inputDir }]);
  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {} } }));

  const summary = migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: true,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  assert.equal(summary.movedProjects.length, 1, "reports planned move");
  assert.equal(existsSync(srcDir), true, "source still present after dry run");
  assert.equal(existsSync(join(fx.projectsRoot, encodeProjectDir(outputDir))), false, "dest not created");
  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[inputDir], "config untouched on dry run");
});

test("ignores a project dir whose name disagrees with the cwd read from its transcript", () => {
  // A session started in /work/proj and was later re-rooted to /work (Claude
  // Code's `/cd ..`), so its transcript lives in the /work project directory
  // while its first record still records cwd /work/proj. Migrating /work/proj
  // must not claim that whole directory and drag /work's own sessions along.
  const fx = setupHome();
  const inputDir = "/work/proj";
  const outputDir = "/moved/proj";

  const srcDir = join(fx.projectsRoot, encodeProjectDir(inputDir));
  writeJsonl(srcDir, "own", [{ type: "user", cwd: inputDir }]);

  const strayDir = join(fx.projectsRoot, encodeProjectDir("/work"));
  writeJsonl(strayDir, "recd", [{ type: "user", cwd: inputDir }]);
  writeJsonl(strayDir, "unrelated", [{ type: "user", cwd: "/work" }]);

  writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [inputDir]: {}, "/work": {} } }));

  const preview = previewMigration({ inputDir, outputDir, mode: "prefix" });
  assert.equal(preview.sessionFolders, 1);
  assert.deepEqual(
    preview.moves.map((m) => m.from),
    [srcDir],
  );

  migrateClaudeState({
    inputDir,
    outputDir,
    mode: "prefix",
    dryRun: false,
    backup: false,
    rewrite: true,
    force: false,
    verbose: false,
    log: () => {},
    warn: () => {},
  });

  // /work's directory is untouched: both of its transcripts stay put.
  assert.deepEqual(readdirSync(strayDir).sort(), ["recd.jsonl", "unrelated.jsonl"]);
  assert.ok(existsSync(join(fx.projectsRoot, encodeProjectDir(outputDir), "own.jsonl")));
  assert.ok(!existsSync(srcDir));

  // Only /work/proj is re-keyed in the config; /work keeps its own entry.
  const cfg = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
  assert.ok(cfg.projects[outputDir]);
  assert.ok(cfg.projects["/work"]);
  assert.ok(!cfg.projects[inputDir]);
});
