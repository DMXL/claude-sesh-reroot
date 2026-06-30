/**
 * Replicates how Claude Code turns an absolute directory path into the
 * storage key used for `~/.claude/projects/<key>/`.
 *
 * Verified against the installed CLI binary (function `Lb`):
 *
 *   const t = p.replace(/[^a-zA-Z0-9]/g, "-");
 *   if (t.length <= 200) return t;
 *   return `${t.slice(0, 200)}-${hash(p)}`;
 *
 * The substitution is lossy (`/`, `.`, `_`, spaces and every other
 * non-alphanumeric character all collapse to `-`) and therefore NOT
 * reversible, which is why this tool always derives the key from a known
 * path rather than trying to decode a directory name.
 *
 * The 200-char truncation appends a custom non-cryptographic hash that we
 * cannot reproduce exactly, so callers should treat encoded names longer
 * than the limit as unsupported (see `exceedsLimit`).
 */

export const MAX_KEY_LENGTH = 200;

/** The lossy 1:1 character substitution Claude Code applies. */
export function encodeProjectDir(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * True when the encoded form would exceed Claude Code's 200-char limit and
 * thus get a hash suffix we cannot replicate.
 */
export function exceedsLimit(absolutePath: string): boolean {
  return encodeProjectDir(absolutePath).length > MAX_KEY_LENGTH;
}
