// R18 (CNDLX-14) / CNDLX-27 section 3: ONE attach seam in core, shaped as a
// QUERY returning an attach target, never an act that attaches. Core
// touches no terminal — resolving `<id-or-name>`, deciding whether it is
// attachable right now, and returning the live session identity is
// EVERYTHING this layer owns. The terminal is the caller's concern: the CLI
// (CNDLX-28) execs into it in place, the daemon's open-terminal seam
// (open-terminal.ts, CNDLX-3) will one day open a window — both call this
// same query rather than each restating the resolution/refusal rules.
//
// R9's split, applied here exactly as agent-lifecycle.ts applies it to the
// eight-verb action set: `decideAttachTarget` below is a PURE function of
// (agent record, the live sessions found under its directory) with no fs,
// no clock, no subprocess — unit-testable per branch, zero and multiple
// sessions included, with no lookup to mock. `getAttachTarget` is the thin
// impure wrapper: load the store, resolve `<id-or-name>` (CNDLX-17's ONE
// resolver), list live sessions under the agent's directory
// (agent-session.ts's `findAgentSessions` — already "the lookup half of
// attach", per CNDLX-14's own doc), then hand both to the pure decision.
//
// Two attaches at once — ruled at the epic level (CNDLX-27's doc): this is
// a READ-ONLY query, and handing the same target to two simultaneous
// callers is correct. candlestix does not lock or arbitrate attach-target;
// unlike the mutating verbs in agent-actions.ts, there is no read-modify-
// write here for the single-writer serialization (mutation-queue.ts) to
// protect, and none is added. What two simultaneous `claude attach` clients
// actually do is Claude Code's own behaviour, measured by CNDLX-28, not
// this ticket.

import type { AgentRecord } from "./agent";
import type { AgentActionsDeps } from "./agent-actions";
import type { StoreTrouble } from "./agent-actions";
import { loadAgentSet } from "./agent-set-store";
import { resolveAgent, type ResolveAgentError } from "./agent-resolver";
import { findAgentSessions } from "./agent-session";
import type { BackgroundAgentInfo } from "./agents-cli";
import type { RunCommand } from "./agents-cli";

export interface AttachTargetDeps {
  agentSetPath: string;
  agentDirectoryPath: (agentId: string) => string;
  runCommand: RunCommand;
}

/** Narrows AgentActionsDeps to exactly what this query needs, so a caller already holding one can pass it straight through. */
export function attachTargetDepsFrom(deps: Pick<AgentActionsDeps, "agentSetPath" | "agentDirectoryPath" | "runCommand">): AttachTargetDeps {
  return { agentSetPath: deps.agentSetPath, agentDirectoryPath: deps.agentDirectoryPath, runCommand: deps.runCommand };
}

export type SessionLookupTrouble = { kind: "session-lookup-failed"; error: string; message: string };

export type AttachTargetError =
  | StoreTrouble
  | ResolveAgentError
  | SessionLookupTrouble
  | { kind: "off"; message: string }
  | { kind: "archived"; message: string }
  | { kind: "no-live-session"; message: string }
  | { kind: "multiple-live-sessions"; sessions: Array<{ id: string; sessionId: string }>; message: string };

export interface AttachTargetSuccess {
  agentId: string;
  agentName: string | undefined;
  /** What `claude attach|logs|stop <id>` take. */
  sessionShortId: string;
  /** Full session UUID. */
  sessionId: string;
}

export type AttachTargetResult = { ok: true; target: AttachTargetSuccess } | { ok: false; error: AttachTargetError };

/**
 * The pure decision (R9, R18). Takes the agent record and every live
 * session `findAgentSessions` found under its directory, and decides:
 * refuse (off/archived — never silently started, same reasoning as
 * on-while-archived), refuse with "not-found"-shaped honesty for zero live
 * sessions ("just created, or died and the reconcile loop has not
 * respawned it yet" — not a hang, not a spawn), refuse listing every
 * session for more than one (R15's mirror gap — never pick the first
 * match), or succeed with the one live session's identity.
 */
export function decideAttachTarget(agent: AgentRecord, sessions: BackgroundAgentInfo[]): AttachTargetResult {
  if (agent.state === "off") {
    return {
      ok: false,
      error: { kind: "off", message: `agent is off; it is not attachable while off — turn it on first, then attach` },
    };
  }
  if (agent.state === "archived") {
    return {
      ok: false,
      error: { kind: "archived", message: `agent is archived; it is not attachable while archived — unarchive it first (which returns it to off), then turn it on` },
    };
  }

  // agent.state === "on" from here down.
  if (sessions.length === 0) {
    return {
      ok: false,
      error: {
        kind: "no-live-session",
        message: `agent is "on" but no live session was found under its directory yet — it is either just created or died and is being brought back by the reconcile loop; this is not a hang and nothing was spawned by this query`,
      },
    };
  }
  if (sessions.length > 1) {
    return {
      ok: false,
      error: {
        kind: "multiple-live-sessions",
        sessions: sessions.map((s) => ({ id: s.id, sessionId: s.sessionId })),
        message: `agent is "on" but ${sessions.length} live sessions were found under its directory (${sessions
          .map((s) => s.id)
          .join(", ")}) — refusing to guess which one to attach to; this should not happen under candlestix's own minted-directory model and is reported rather than resolved by picking the first match`,
      },
    };
  }

  const session = sessions[0] as BackgroundAgentInfo;
  return {
    ok: true,
    target: {
      agentId: agent.id,
      agentName: agent.name,
      sessionShortId: session.id,
      sessionId: session.sessionId,
    },
  };
}

/** The impure wrapper: load the store, resolve `<id-or-name>`, list live sessions under the agent's directory, then apply the pure decision. */
export async function getAttachTarget(deps: AttachTargetDeps, query: string): Promise<AttachTargetResult> {
  const loaded = await loadAgentSet(deps.agentSetPath);
  if (loaded.kind === "malformed") {
    return {
      ok: false,
      error: { kind: "store-malformed", error: loaded.error, message: `the agent set store is malformed and cannot be used: ${loaded.error}` },
    };
  }

  const resolved = resolveAgent(loaded.agentSet, query);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { agent } = resolved;

  let sessions: BackgroundAgentInfo[];
  try {
    sessions = await findAgentSessions(deps.runCommand, deps.agentDirectoryPath(agent.id));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: { kind: "session-lookup-failed", error: detail, message: `could not determine whether a live session exists for this agent: ${detail}` },
    };
  }

  return decideAttachTarget(agent, sessions);
}
