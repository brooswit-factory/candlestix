// S2 + R7 + S3: find the live `claude --bg` session(s) backing a
// daemon-managed agent by its DIRECTORY, never by the session registry
// (src/registry.ts) — that registry is the reconcile loop's own
// bookkeeping, not ours, and this module intentionally does not depend on
// it (R16 finding #2: at the time this module was written, that registry
// was still name-keyed; CNDLX-19 has since re-keyed it to the agent's
// durable id, but the reason to stay independent of it here is unchanged
// — this is the ground-truth lookup CNDLX-19's own reconcile loop is
// instructed to prefer over trusting its registry alone). And stop/remove
// exactly the session(s) found, using the per-session verbs `claude`
// itself provides (`stop`/`rm`) — never a cgroup, a scope, or `systemctl`
// (R7).

import { parseAgentsJson, type BackgroundAgentInfo, type RunCommand } from "./agents-cli";

/**
 * `claude agents --json --cwd <cwd>` is documented as showing sessions
 * started UNDER <cwd> — a PREFIX match, not an exact one. We use it as a
 * cheap server-side pre-filter (this Unix user could have many sessions
 * across many directories) but never trust it alone: the exact-match
 * filter below is what actually decides which sessions belong to this
 * agent. `--all` is deliberately omitted, same reasoning as
 * `listBackgroundAgents` in agents-cli.ts: an already-exited session is not
 * a candidate to stop or remove.
 *
 * Throws on failure (non-zero exit, unparseable output) rather than
 * returning `[]` — "the listing failed" and "the listing succeeded and
 * found nothing" must never look the same to a caller about to decide
 * whether a live session exists.
 */
export async function findAgentSessions(runCommand: RunCommand, cwd: string): Promise<BackgroundAgentInfo[]> {
  const result = await runCommand(["claude", "agents", "--json", "--cwd", cwd], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error(`\`claude agents --json --cwd ${cwd}\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const sessions = parseAgentsJson(result.stdout);
  return sessions.filter((session) => session.cwd === cwd);
}

export type StopSessionResult = { ok: true } | { ok: false; error: string };

/**
 * R7: stops exactly ONE session, by its own recorded short id (what
 * `claude stop` takes) — never a cgroup, a scope, or `systemctl --user
 * stop`. The conversation is kept (per `claude stop --help` at this
 * ticket's own commit — verify at yours).
 */
export async function stopSession(runCommand: RunCommand, sessionShortId: string): Promise<StopSessionResult> {
  const result = await runCommand(["claude", "stop", sessionShortId], { timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    return { ok: false, error: `\`claude stop ${sessionShortId}\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}

export type RemoveSessionResult = { ok: true } | { ok: false; error: string };

/**
 * S3: `claude rm <id>` deletes the session AND its conversation, and is
 * documented to work on sessions that have already exited — so this is
 * always called AFTER `stopSession` succeeds (see
 * `stopAndRemoveAllSessionsUnderCwd` below and `deleteAgent`'s effect in
 * agent-actions.ts), never instead of it.
 */
export async function removeSession(runCommand: RunCommand, sessionShortId: string): Promise<RemoveSessionResult> {
  const result = await runCommand(["claude", "rm", sessionShortId], { timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    return { ok: false, error: `\`claude rm ${sessionShortId}\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}

export interface StopAllSessionsUnderCwdResult {
  /** Short ids that were found and successfully stopped. Empty means "no live session found" — genuinely a success, not an error. */
  stopped: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * S2's ambiguity ruling, made explicit rather than taking the first match:
 * if more than one live session's cwd matches this agent's directory
 * exactly, stop ALL of them. Reasoning: the recorded intention this action
 * is trying to reach is "no live session under this directory" — stopping
 * every match reaches that state regardless of which one, if any, was the
 * "real" one, whereas stopping only the first would silently leave a
 * second live session running under a directory the store now says is off.
 */
export async function stopAllSessionsUnderCwd(runCommand: RunCommand, cwd: string): Promise<StopAllSessionsUnderCwdResult> {
  const sessions = await findAgentSessions(runCommand, cwd);
  const stopped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const session of sessions) {
    const result = await stopSession(runCommand, session.id);
    if (result.ok) {
      stopped.push(session.id);
    } else {
      failed.push({ id: session.id, error: result.error });
    }
  }
  return { stopped, failed };
}

export interface StopAndRemoveAllSessionsUnderCwdResult {
  removed: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * S3's delete ordering (stop, then remove), applied to EVERY session
 * matching this agent's directory exactly, for the same "no live session
 * left under this directory" reasoning as `stopAllSessionsUnderCwd`. A
 * session that fails to stop is deliberately NOT then handed to `rm` —
 * removing a session's conversation while it might still be running is
 * strictly worse than leaving it stopped-but-present for a human to
 * investigate.
 */
export async function stopAndRemoveAllSessionsUnderCwd(runCommand: RunCommand, cwd: string): Promise<StopAndRemoveAllSessionsUnderCwdResult> {
  const sessions = await findAgentSessions(runCommand, cwd);
  const removed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const session of sessions) {
    const stopResult = await stopSession(runCommand, session.id);
    if (!stopResult.ok) {
      failed.push({ id: session.id, error: stopResult.error });
      continue;
    }
    const rmResult = await removeSession(runCommand, session.id);
    if (rmResult.ok) {
      removed.push(session.id);
    } else {
      failed.push({ id: session.id, error: rmResult.error });
    }
  }
  return { removed, failed };
}
