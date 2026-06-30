import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RewriteMode = "prefix" | "exact";

/**
 * Build a string transformer that re-homes path references.
 *
 * - `prefix`: used when the files physically moved. Rewrites `inputDir` and any
 *   path strictly under it (`inputDir/...`) onto `outputDir`.
 * - `exact`: used for state-only migrations (including the nested
 *   `/root` -> `/root/A` case). Rewrites only strings equal to `inputDir`, so
 *   deeper paths that did not move are left untouched and we avoid turning
 *   `/root/A/foo` into `/root/A/A/foo`.
 */
export function makeRewriter(inputDir: string, outputDir: string, mode: RewriteMode): (s: string) => string {
  const prefix = inputDir.endsWith("/") ? inputDir : inputDir + "/";
  return (s: string): string => {
    if (s === inputDir) return outputDir;
    if (mode === "prefix" && s.startsWith(prefix)) return outputDir + s.slice(inputDir.length);
    return s;
  };
}

/** Recursively apply `fn` to every string in a parsed JSON value. */
function transform(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => transform(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = transform(v, fn);
    return out;
  }
  return value;
}

/** Rewrite one jsonl file in place (atomic via temp + rename). Returns the number of changed lines. */
export function rewriteJsonlFile(filePath: string, rewrite: (s: string) => string): number {
  const original = readFileSync(filePath, "utf8");
  const trailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (trailingNewline) lines.pop();

  let changed = 0;
  const rewritten = lines.map((line) => {
    if (!line.trim()) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // leave malformed lines as-is
    }
    const next = JSON.stringify(transform(parsed, rewrite));
    if (next !== line) changed++;
    return next;
  });

  if (changed > 0) {
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, rewritten.join("\n") + (trailingNewline ? "\n" : ""));
    renameSync(tmp, filePath);
  }
  return changed;
}

/** Collect every `.jsonl` file under `dir`, recursing into subdirectories. */
export function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...collectJsonlFiles(full));
    else if (entry.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Rewrite path references across every transcript under `projectDir`. */
export function rewriteTranscripts(
  projectDir: string,
  inputDir: string,
  outputDir: string,
  mode: RewriteMode,
): { files: number; changedLines: number } {
  const rewrite = makeRewriter(inputDir, outputDir, mode);
  let files = 0;
  let changedLines = 0;
  for (const file of collectJsonlFiles(projectDir)) {
    const changed = rewriteJsonlFile(file, rewrite);
    if (changed > 0) {
      files++;
      changedLines += changed;
    }
  }
  return { files, changedLines };
}
