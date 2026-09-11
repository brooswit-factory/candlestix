// The pure transition rules for the eight-verb action set (CNDLX-23, on top
// of CNDLX-17/22's record, store and resolver). R9: decide "is this
// transition legal, and what does it become" as a pure function over the
// current record; the impure effects (directory, session stop/start, store
// write) are applied separately by src/agent-actions.ts. Nothing here
// touches fs, a clock, a subprocess, or the store — every decision is a
// total function of an `AgentLifecycleState` (or, for rename, of a name and
// the set it must stay unique within, already provided pure by
// agent-set.ts's `renameAgent`).
//
// Deliberately NOT here: `create` and `list`. `create`'s only "transition"
// is start-from-nothing plus a name-allowed check (see
// `checkAgentNameAllowed` below, reused by `create` and `rename` alike, R17)
// composed with `insertAgent` (agent-set.ts) — there is no prior state to
// switch on. `list` has no transition at all; it is a plain projection over
// `AgentSet` and lives with the other actions in agent-actions.ts.

import type { AgentLifecycleState } from "./agent";
import { validateAgentNameSyntax, type NameValidationError } from "./agent";

// R17: the epic's ruling is to reserve the WHOLE action-set vocabulary, not
// just the five CLI verbs that exist today — "reserving a word later is a
// breaking change for any agent already holding it; un-reserving one later
// breaks nothing," so the cheap, reversible direction is the superset. This
// list is `create, attach, on, off, rename, name, archive, unarchive,
// delete, list` (the epic's five words plus `create`, `attach`, `unarchive`
// and `list` — the actions this ticket adds or that CNDLX-3 owns), plus
// `open-terminal` (CNDLX-32/CNDLX-27): R17's standing rule is "whoever names
// a new verb reserves that word at the same moment" — reserving it now,
// while nothing can yet hold the name (no create/CLI surface existed until
// this same PR), is free; reserving it later would be a breaking change for
// whatever agent already held it.
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "create",
  "attach",
  "on",
  "off",
  "rename",
  "name",
  "archive",
  "unarchive",
  "delete",
  "list",
  "open-terminal",
]);

export type NameAllowedError =
  | { kind: "invalid-syntax"; message: string }
  | { kind: "reserved"; word: string; message: string };

export type NameAllowedResult = { ok: true } | { ok: false; error: NameAllowedError };

/**
 * Layers R17's reserved-word refusal on top of CNDLX-17's standalone,
 * composable `validateAgentNameSyntax` — exactly the shape its own doc
 * comment invites (`const s = validateAgentNameSyntax(x); if (s.ok &&
 * RESERVED.has(x)) {...}`) — rather than forking or re-implementing the
 * syntax rule. This is the ONE place both `create` and `rename` consult, so
 * the reserved list cannot drift between the two entry points that let a
 * name into the system.
 */
export function checkAgentNameAllowed(name: string): NameAllowedResult {
  const syntax = validateAgentNameSyntax(name);
  if (!syntax.ok) {
    return { ok: false, error: { kind: "invalid-syntax", message: (syntax.error as NameValidationError).message } };
  }
  if (RESERVED_AGENT_NAMES.has(name)) {
    return {
      ok: false,
      error: {
        kind: "reserved",
        word: name,
        message: `"${name}" is reserved (part of the candlestix action-set vocabulary) and cannot be used as an agent name`,
      },
    };
  }
  return { ok: true };
}

/** What an effect-applying caller must do after a legal transition. Nothing here says HOW — that is agent-actions.ts's job. */
export type LifecycleEffect = "start-session" | "stop-session" | "none";

export type OnDecision =
  | { kind: "no-change" }
  | { kind: "transition"; to: "on"; effect: "start-session" }
  | { kind: "refused"; code: "already-archived"; message: string };

/** S4's `on` column. Turning an archived agent on is REFUSED, never silently unarchived — the human's acked interpretation. */
export function decideOn(state: AgentLifecycleState): OnDecision {
  switch (state) {
    case "on":
      return { kind: "no-change" };
    case "off":
      return { kind: "transition", to: "on", effect: "start-session" };
    case "archived":
      return {
        kind: "refused",
        code: "already-archived",
        message: "agent is archived; turning an archived agent on is refused — unarchive it first, which returns it to off",
      };
  }
}

export type OffDecision =
  | { kind: "no-change" }
  | { kind: "transition"; to: "off"; effect: "stop-session" }
  | { kind: "refused"; code: "already-archived"; message: string };

/** S4's `off` column. Archived is not live, so `off` on an archived agent is refused (name `unarchive` in the message, per R8). */
export function decideOff(state: AgentLifecycleState): OffDecision {
  switch (state) {
    case "on":
      return { kind: "transition", to: "off", effect: "stop-session" };
    case "off":
      return { kind: "no-change" };
    case "archived":
      return {
        kind: "refused",
        code: "already-archived",
        message: 'agent is archived, not live; "off" does not apply to an archived agent — use "unarchive" first',
      };
  }
}

export type ArchiveDecision =
  | { kind: "transition"; to: "archived"; effect: "stop-session" | "none" }
  | { kind: "refused"; code: "already-archived"; message: string };

/** S4's `archive` column: legal from on (stops the session) and off (no session to stop); refused if already archived. */
export function decideArchive(state: AgentLifecycleState): ArchiveDecision {
  switch (state) {
    case "on":
      return { kind: "transition", to: "archived", effect: "stop-session" };
    case "off":
      return { kind: "transition", to: "archived", effect: "none" };
    case "archived":
      return { kind: "refused", code: "already-archived", message: "agent is already archived" };
  }
}

export type UnarchiveDecision =
  | { kind: "transition"; to: "off"; effect: "none" }
  | { kind: "refused"; code: "not-archived"; message: string };

/** S4's `unarchive` column: only legal from archived, and always lands on `off` — never `on` (the human's model: unarchive returns to live-and-off). */
export function decideUnarchive(state: AgentLifecycleState): UnarchiveDecision {
  if (state === "archived") {
    return { kind: "transition", to: "off", effect: "none" };
  }
  return { kind: "refused", code: "not-archived", message: `agent is not archived (state is "${state}"); "unarchive" does not apply` };
}

export type DeleteDecision = { kind: "transition"; effect: "stop-session" };

/**
 * S4's `delete` column: legal from every known state, unconditionally.
 * `effect` is always `"stop-session"` rather than being conditioned on the
 * recorded state — S3's ordering (stop the live session, if any, before
 * removing the directory) is a safety net independent of what the store
 * *believes* is running, because the thing being torn down next is the
 * directory itself. Applying the effect is idempotent by construction at
 * the session-lookup layer (agent-actions.ts): zero matching sessions is a
 * no-op, not an error.
 */
export function decideDelete(_state: AgentLifecycleState): DeleteDecision {
  return { kind: "transition", effect: "stop-session" };
}
