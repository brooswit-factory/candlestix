// Wraps `claude agents --json`, the officially scriptable listing of
// Claude Code's own background sessions ("for scripting; does not require
// a TTY" per `claude agents --help`). This is candlestix's window into
// which blank agents are actually alive — see the module doc comment in
// reconcile.ts for how this is combined with a direct OS check rather than
// trusted on its own.

export interface BackgroundAgentInfo {
  /** Short id: what `claude attach|logs|stop` take. */
  id: string;
  /** Full session UUID. */
  sessionId: string;
  cwd: string;
  /** Epoch ms. */
  startedAt: number;
  /**
   * Absent, not merely null, when `claude`'s own daemon does not currently
   * have a resolvable backing OS process to report for this session.
   * OBSERVED LIVE during development: right after a spare pty-host was
   * killed to simulate a crash, the session's own entry stayed listed but
   * lost its `pid` for a couple of seconds while `claude`'s daemon
   * transparently re-homed it — the session was never actually dead. A
   * caller that read bare listedness as "healthy" would have gotten the
   * right answer that time by luck; reconcile.ts never does, so an absent
   * `pid` costs one skipped heartbeat rather than gambling on an
   * undocumented internal timing.
   */
  pid: number | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure parser: JSON text in, typed list out. Throws on input that is not a
 * JSON array — deliberately, unlike `parseRoster`'s "collect errors, never
 * throw" convention, because the roster is hand-edited (wrong input is the
 * expected case) while this is machine output from a specific CLI contract
 * (`--json`); a caller that gets something else back needs to treat the
 * whole read as failed, not silently proceed with an empty list — an empty
 * list here is indistinguishable from "nothing is running" and would risk
 * spawning duplicates for agents that are, in fact, alive. See
 * `listBackgroundAgents` below for how the throw is turned into "we don't
 * know this cycle" rather than "nothing is running".
 *
 * A malformed *individual* entry (missing/wrong-typed required field) is
 * skipped rather than failing the whole parse — one odd entry (a future
 * `claude` version adding a field, an entry mid-write) should not blind
 * candlestix to every other, valid entry.
 */
export function parseAgentsJson(raw: string): BackgroundAgentInfo[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("expected `claude agents --json` to print a JSON array");
  }

  const result: BackgroundAgentInfo[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    if (item["kind"] !== "background") continue;
    const { id, sessionId, cwd, startedAt } = item;
    if (typeof id !== "string" || typeof sessionId !== "string" || typeof cwd !== "string" || typeof startedAt !== "number") {
      continue;
    }
    const pid = typeof item["pid"] === "number" ? (item["pid"] as number) : undefined;
    result.push({ id, sessionId, cwd, startedAt, pid });
  }
  return result;
}

export interface RunCommand {
  (argv: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Lists Claude Code's currently-running background sessions (excludes
 * already-stopped ones — `--all` is deliberately omitted, since a stopped
 * session is not a candidate to adopt). Throws on any failure (non-zero
 * exit, unparseable output) rather than returning `[]`, for the same
 * reason `parseAgentsJson` throws: a caller must be able to tell "the
 * listing failed" apart from "the listing succeeded and found nothing".
 */
export async function listBackgroundAgents(runCommand: RunCommand): Promise<BackgroundAgentInfo[]> {
  const result = await runCommand(["claude", "agents", "--json"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error(`\`claude agents --json\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return parseAgentsJson(result.stdout);
}
