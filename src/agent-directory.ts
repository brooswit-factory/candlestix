// S1 + S3: the per-agent directory candlestix creates and owns, and the
// dangerous recursive removal that `delete` performs on it. The guard below
// is deliberately its own PURE function, independently testable with
// hostile inputs and no real filesystem — S3's own words: "make the guard a
// test, not a comment."

import { mkdir, rm as fsRm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isAgentId } from "./agent-id";

export type DirectoryRemovalGuardResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Refuses unless `id` is structurally a minted id (`isAgentId`), AND
 * refuses unless the resolved absolute path it derives is a DIRECT CHILD of
 * `agentsBaseDir` — not `agentsBaseDir` itself, and not some path reached
 * by escaping it. Given `isAgentId`'s alphabet (no `/`, no `.`, no `..`, no
 * leading `/`), the second check is structurally unreachable through any
 * input that already passes the first — this is intentional
 * belt-and-suspenders, S3's own framing for this exact guard, not evidence
 * the second check is dead: it is what keeps this function correct even if
 * `isAgentId`'s alphabet ever changed in a way that stopped excluding path
 * separators, rather than depending on that exclusion silently forever.
 *
 * Pure: builds paths with `node:path` only, touches no filesystem, so it
 * can be fed arbitrary hostile strings in a test with no temp directory and
 * no risk of ever actually removing anything.
 */
export function guardAgentDirectoryRemoval(agentsBaseDir: string, id: string): DirectoryRemovalGuardResult {
  if (!isAgentId(id)) {
    return { ok: false, reason: `refusing to remove a directory for "${id}": not a structurally valid minted agent id` };
  }
  const base = resolve(agentsBaseDir);
  const candidate = resolve(base, id);
  if (dirname(candidate) !== base) {
    return { ok: false, reason: `refusing to remove "${candidate}": not a direct child of the agents base directory "${base}"` };
  }
  return { ok: true, path: candidate };
}

/** S1: creates the per-agent directory. Idempotent — `recursive: true` makes a pre-existing directory a success, not an error. */
export async function createAgentDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export type RemoveAgentDirectoryResult = { ok: true } | { ok: false; reason: string };

/**
 * S3's dangerous step, guarded. Re-derives and checks the path itself
 * (`guardAgentDirectoryRemoval`) rather than trusting a path the caller
 * already built — the whole point of the guard is that nothing upstream of
 * this function is trusted to have gotten it right. `force: true` makes
 * "the directory was already gone" a success rather than an error (this
 * function's own idempotence), not a way to swallow a real removal
 * failure — `fsRm`'s only other failure modes here (permissions, a
 * concurrent removal race) still reject and are reported as `{ ok: false }`.
 */
export async function removeAgentDirectory(
  agentsBaseDir: string,
  id: string,
  rm: (path: string) => Promise<void> = (path) => fsRm(path, { recursive: true, force: true })
): Promise<RemoveAgentDirectoryResult> {
  const guard = guardAgentDirectoryRemoval(agentsBaseDir, id);
  if (!guard.ok) {
    return guard;
  }
  try {
    await rm(guard.path);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `removing "${guard.path}" failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
