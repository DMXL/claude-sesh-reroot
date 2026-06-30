import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type FileAction =
  | "move-rename" // output_dir absent: mv input_dir output_dir
  | "merge-into-empty" // output_dir exists and is empty
  | "merge-into-nonempty" // output_dir exists and is non-empty (needs confirmation)
  | "state-only"; // do not touch files

export interface FileStrategy {
  action: FileAction;
  reason: string;
  /** True when the action relocates files, so transcripts use prefix rewriting. */
  filesMove: boolean;
  /** True when the user must confirm before proceeding. */
  needsConfirm: boolean;
}

/** True if `child` is `parent` or lives underneath it. */
export function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/** Decide what to do with the project files on disk (auto-detect, per the plan). */
export function determineFileStrategy(inputDir: string, outputDir: string): FileStrategy {
  if (!isDir(inputDir)) {
    return {
      action: "state-only",
      reason: `input dir does not exist on disk (${inputDir}); migrating Claude state only`,
      filesMove: false,
      needsConfirm: false,
    };
  }
  if (isInside(outputDir, inputDir) || isInside(inputDir, outputDir)) {
    return {
      action: "state-only",
      reason: "paths are nested; cannot safely move the folder, migrating Claude state only",
      filesMove: false,
      needsConfirm: false,
    };
  }
  if (!existsSync(outputDir)) {
    return {
      action: "move-rename",
      reason: `renaming ${inputDir} -> ${outputDir}`,
      filesMove: true,
      needsConfirm: false,
    };
  }
  if (isEmptyDir(outputDir)) {
    return {
      action: "merge-into-empty",
      reason: `moving contents into empty ${outputDir}`,
      filesMove: true,
      needsConfirm: false,
    };
  }
  return {
    action: "merge-into-nonempty",
    reason: `${outputDir} already exists and is not empty`,
    filesMove: true,
    needsConfirm: true,
  };
}

/** rename(), falling back to recursive copy + remove across filesystems. */
function moveEntry(src: string, dest: string): void {
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
}

/** Move every entry of `src` into `dest`. Existing destination entries are kept unless `force`. */
function moveContents(src: string, dest: string, force: boolean): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (existsSync(to)) {
      if (!force) continue; // keep destination's version
      rmSync(to, { recursive: true, force: true });
    }
    moveEntry(from, to);
  }
}

/** Execute the file strategy. No-op for `state-only`. */
export function applyFileStrategy(
  strategy: FileStrategy,
  inputDir: string,
  outputDir: string,
  force: boolean,
): void {
  switch (strategy.action) {
    case "state-only":
      return;
    case "move-rename": {
      mkdirSync(dirname(outputDir), { recursive: true });
      moveEntry(inputDir, outputDir);
      return;
    }
    case "merge-into-empty":
    case "merge-into-nonempty": {
      moveContents(inputDir, outputDir, force);
      if (isEmptyDir(inputDir)) rmSync(inputDir, { recursive: true, force: true });
      return;
    }
  }
}
