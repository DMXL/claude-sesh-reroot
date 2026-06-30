import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeProjectDir } from "../src/encode.js";
import { migrateClaudeState } from "../src/migrate.js";

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
