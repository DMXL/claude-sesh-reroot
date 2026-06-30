# claude-sesh-reroot

Re-home your Claude Code sessions when you move a project folder, so you can `claude --resume` from the new location.

## The problem

When you run `claude` in a directory, Claude Code keys all of that session's state to the directory path. Move or rename the folder and `claude --resume` from the new location finds nothing, because Claude derives its storage key from the path. The classic case: you start a session in `/root`, then realise the project should live in `/root/A`, but the session is stranded at `/root`.

This tool migrates everything Claude Code associates with one directory over to another:

- the project's session transcripts under `~/.claude/projects/<encoded-path>/`
- the per-project entry in `~/.claude.json` (`projects` and `githubRepoPaths`)
- absolute path references recorded inside the transcripts (`cwd`, etc.)

Session-id-keyed state (`file-history/`, `session-env/`) needs no change; it rides along inside the project directory.

## Install

```sh
pnpm install
pnpm build
pnpm link --global      # exposes the `claude-sesh-reroot` command
```

Or run without installing:

```sh
pnpm dev <input_dir> <output_dir>      # tsx, no build step
```

## Usage

```sh
claude-sesh-reroot <input_dir> <output_dir> [options]
```

Then:

```sh
cd <output_dir> && claude --resume
```

### Example: re-home a session into a subfolder

```sh
# started in /root, project now lives in /root/A
claude-sesh-reroot /root /root/A
cd /root/A && claude --resume
```

### Example: rename a project folder

```sh
claude-sesh-reroot ~/Work/old-name ~/Work/new-name
```

## What it does with your files

File handling is auto-detected, with confirmation when anything is ambiguous:

| Situation | Behavior |
|---|---|
| `output_dir` does not exist | Folder is moved/renamed (`input_dir` -> `output_dir`) |
| `output_dir` exists and is empty | `input_dir`'s contents are moved into it |
| `output_dir` exists and is non-empty | You are asked before merging |
| `output_dir` is nested in `input_dir` (or `input_dir` is gone) | Claude state only; your files are left untouched |

Transcript path rewriting adapts to this: when files actually move, references under `input_dir` are rewritten to `output_dir`; in state-only mode only the exact session `cwd` is updated, so a path like `/root/A/foo` is never mangled into `/root/A/A/foo`.

## Options

| Flag | Effect |
|---|---|
| `-n`, `--dry-run` | Show what would happen; change nothing |
| `-y`, `--yes` | Skip confirmation prompts |
| `--state-only` | Never move files; migrate Claude state only |
| `--no-rewrite` | Do not rewrite path strings inside transcripts |
| `--no-backup` | Skip the timestamped backups |
| `--force` | Overwrite collisions and proceed past safety checks |
| `-v`, `--verbose` | Extra logging |
| `-h`, `--help` | Show help |

By default a timestamped backup of each migrated project directory is written next to it (`<dir>.bak-<timestamp>`), and `~/.claude.json` is copied into `~/.claude/backups/` before any change.

## Notes and limitations

- Run it **after exiting** the session you want to move. A live session holds its transcript open and rewrites the old location on exit. The tool warns if it detects a session record still pointing at `input_dir`.
- The path-to-key encoding Claude Code uses (`path.replace(/[^a-zA-Z0-9]/g, "-")`) is lossy. Paths whose encoded form exceeds 200 characters are unsupported, because Claude's truncation hash cannot be reproduced; the tool refuses unless you pass `--force`.
- `~/.claude/plans/*.md` prose paths and global shell snapshots are intentionally not touched.
- Honors `CLAUDE_CONFIG_DIR` if you have relocated Claude's config directory.

## Development

```sh
pnpm test     # node:test suite via tsx
pnpm build    # tsc -> dist/
```

## License

MIT
