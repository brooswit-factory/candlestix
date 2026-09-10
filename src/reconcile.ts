import type { BackgroundAgentInfo } from "./agents-cli";
import type { RegistryEntry } from "./registry";
import type { AgentLifecycleState } from "./agent";

// Pure reconcile decision for a single daemon-owned agent. No fs, no
// child_process, no clock read, no ambient state — every input this needs
// is a parameter, the same discipline `staleness.ts` uses, and for the
// same reason.
//
// CNDLX-19 T1: this is desired-state driven. `state` — the agent's
// CURRENTLY RECORDED lifecycle state, read fresh from CNDLX-17's durable
// agent set every cycle — is the one new input this ticket adds over the
// pre-CNDLX-19 shape (which had no state input at all and always spawned
// when nothing was found). `off` and `archived` are never spawned, by
// ANY path through this function — see the `state !== "on"` branch below,
// which returns before `spawn` is ever reachable.
//
// CNDLX-19 T2: this loop is SPAWN-ONLY. It never decides to stop or remove
// a session — there is no action type here that means "kill it". When an
// `off`/`archived` agent has a live session running under its directory
// anyway, the only action available is `unexpected-session`: report the
// disagreement, take no action on the session. Reasoning (belongs here and
// in the README, not just the ticket): the first `claude --bg` invocation
// for a Unix user spawns a long-lived singleton every later `--bg` session
// shares, inheriting whatever cgroup its first invoker was in (see the
// spawn module's own comment) — a loop that kills sessions automatically,
// on a timer, with nobody watching, is the most likely way this product
// takes down background sessions that are not even its own. Separately,
// this loop cannot tell "off, with a stray session" apart from "the `off`
// record is stale because a store write failed right after a start" (T7) —
// stopping there could destroy a session an operator just created;
// reporting costs one visible, recoverable log line. `turnOff`
// (agent-actions.ts) already stops the session when the operator asks;
// this loop's job is to not UNDO that intention, never to re-enforce it.
//
// CNDLX-19 T5: adoption (finding a live session for an `on` agent with no
// registry match) keys on the agent's DIRECTORY, derived from its id. In
// candlestix's own minted-directory model this makes "two agents share a
// directory" structurally impossible (the directory's namespace is owned
// by the same process doing the adopting) — see the README for why this
// claim is scoped to that model and does not generalise to every possible
// directory-adoption scheme. The mirror ambiguity — two live sessions
// sharing one directory — does NOT disappear and is NOT silently resolved
// by taking the first match: see the `wait` branch below when more than
// one directory match exists with no identity match.
//
// CNDLX-19 T7 (H3): this function OBEYS `state` exactly as given, with no
// heuristic override. If a `store-write-failed` result (agent-actions.ts)
// left the durable record stale relative to a session just started or
// stopped, that surfaces here as an ordinary disagreement between `state`
// and `backgroundAgents` — a `wait` or `unexpected-session` action — never
// as this function second-guessing which one to believe.
//
// The heartbeat contract this exists to honour (see health/heartbeat.ts):
// record a heartbeat WHEN, AND ONLY WHEN, this agent's cycle genuinely
// completed — i.e. candlestix positively, independently confirmed it is
// alive, or positively confirmed a fresh spawn succeeded. "Listed by
// `claude agents --json`" alone is deliberately NOT sufficient — see
// `verifiedAlivePids` below and `agents-cli.ts`'s doc comment for the real,
// observed reason.
//
// DELIBERATE DECISION, inherited unchanged from before this ticket: the
// `wait` action is unbounded — there is no consecutive-cycle counter, no
// escalation to `spawn` after N cycles of `wait`. Falling through to
// `spawn` after some bound can create a genuine duplicate session next to
// one that was never actually dead, only slow to re-verify — a strictly
// worse failure than staying stuck. `wait` never fabricates health: the
// heartbeat stops, the subject goes `stale` (health/staleness.ts), and
// `startStalenessAlarm` gets loud on its own.

export interface ReconcileInputs {
  agentId: string;
  /** Display only (T4) — never matched or keyed against anywhere below. */
  agentName: string | undefined;
  state: AgentLifecycleState;
  /** This agent's own directory — `paths.ts`'s `agentDirectoryPath(agentId)`, derived from the id (T5). */
  agentDir: string;
  /** What candlestix's own id-keyed (T4) session registry currently believes backs this agent, if anything. */
  registryEntry: RegistryEntry | undefined;
  /** This cycle's full `claude agents --json` listing. */
  backgroundAgents: BackgroundAgentInfo[];
  /**
   * pids that the caller independently confirmed alive via `kill(pid, 0)`
   * (or equivalent) AT THE SAME MOMENT `backgroundAgents` was fetched. See
   * the README's "The registry" section for the full architecture-level
   * reasoning this mirrors.
   */
  verifiedAlivePids: ReadonlySet<number>;
  /** Whether `agentDir` currently exists on disk, checked fresh this cycle. */
  dirExists: boolean;
}

export type ReconcileAction =
  | { type: "heartbeat"; entry: RegistryEntry }
  | { type: "spawn" }
  | { type: "wait"; reason: string }
  | { type: "dir-missing" }
  /** `off`/`archived`, no live session found under this agent's directory — the expected, quiet steady state. Nothing to do. */
  | { type: "not-subject" }
  /**
   * T2: `off`/`archived`, but one or more live sessions ARE running under
   * this agent's directory. This is a report-only action — the loop never
   * stops or removes a session. The CALLER (supervisor.ts) is responsible
   * for T2's no-repeat rule (do not re-emit an identical warning every
   * cycle for an unchanged condition); this pure function reports the same
   * fact every time it is asked, on purpose — deduplication is the
   * impure caller's job, not this decision's.
   */
  | { type: "unexpected-session"; sessionIds: string[]; reason: string };

function findByIdentity(registryEntry: RegistryEntry | undefined, backgroundAgents: BackgroundAgentInfo[]): BackgroundAgentInfo | undefined {
  if (!registryEntry) return undefined;
  return backgroundAgents.find((a) => a.sessionId === registryEntry.sessionId || a.id === registryEntry.sessionShortId);
}

export function decideReconcileAction(inputs: ReconcileInputs): ReconcileAction {
  const dirMatches = inputs.backgroundAgents.filter((a) => a.cwd === inputs.agentDir);

  if (inputs.state !== "on") {
    if (dirMatches.length === 0) {
      return { type: "not-subject" };
    }
    return {
      type: "unexpected-session",
      sessionIds: dirMatches.map((a) => a.id),
      reason: `agent is "${inputs.state}" but ${dirMatches.length} live session(s) are running under its directory (${dirMatches
        .map((a) => a.id)
        .join(", ")}) — the loop never stops a session on its own, only reports the disagreement`,
    };
  }

  // state === "on" from here down.
  const byIdentity = findByIdentity(inputs.registryEntry, inputs.backgroundAgents);
  const candidate = byIdentity ?? (dirMatches.length === 1 ? dirMatches[0] : undefined);

  if (!candidate) {
    if (dirMatches.length > 1) {
      // T5: genuinely ambiguous adoption — never guess, never take the
      // first match. Reported the same way a dead/unverifiable candidate
      // is: `wait` for the next cycle, no spawn, no pick.
      return {
        type: "wait",
        reason: `${dirMatches.length} live sessions match this agent's directory exactly and none matches the registry — refusing to adopt ambiguously (ids: ${dirMatches
          .map((a) => a.id)
          .join(", ")})`,
      };
    }
    if (!inputs.dirExists) {
      return { type: "dir-missing" };
    }
    return { type: "spawn" };
  }

  if (candidate.pid !== undefined && inputs.verifiedAlivePids.has(candidate.pid)) {
    // spawnedAt is carried forward from the registry ONLY when the
    // candidate is genuinely the SAME session the registry already knew
    // about (matched by sessionId) — never merely because a registry
    // entry happened to exist for this agent. A directory-adoption match,
    // or a fresh spawn that replaced a session the registry hadn't caught
    // up to yet, is a DIFFERENT session for the same agent, and must get
    // its own spawnedAt (candidate.startedAt), not inherit a
    // predecessor's.
    const sameSessionAsRegistry = inputs.registryEntry?.sessionId === candidate.sessionId;
    return {
      type: "heartbeat",
      entry: {
        agentId: inputs.agentId,
        ...(inputs.agentName !== undefined ? { agentName: inputs.agentName } : {}),
        sessionShortId: candidate.id,
        sessionId: candidate.sessionId,
        cwd: candidate.cwd,
        spawnedAt: sameSessionAsRegistry ? inputs.registryEntry!.spawnedAt : new Date(candidate.startedAt).toISOString(),
      },
    };
  }

  return {
    type: "wait",
    reason:
      candidate.pid === undefined
        ? `session "${candidate.id}" is listed but claude's daemon reported no pid for it this cycle`
        : `session "${candidate.id}" reported pid ${candidate.pid}, which did not independently verify as alive`,
  };
}
