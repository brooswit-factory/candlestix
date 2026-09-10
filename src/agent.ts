// The agent record (CNDLX-22 / CNDLX-17): the durable shape candlestix's
// own daemon-managed agents are stored as, plus name validation.
//
// This module deliberately does NOT include any lifecycle verb
// (create/on/off/rename/archive/unarchive/delete/list) — those are sibling
// tickets' scope. It provides the type those verbs will construct and
// mutate, and the pure validation rule a "rename"/"create" action must
// consult before it is allowed to touch a name.

import { isAgentId } from "./agent-id";

/**
 * R6: a flat three-valued field. The fourth operator-visible state,
 * "deleted", is represented by absence from the store's `agents` map
 * (see agent-set.ts) rather than as a fourth value here — an agent that no
 * longer exists is not a record with a state, it is not a record.
 */
export type AgentLifecycleState = "on" | "off" | "archived";

export interface AgentRecord {
  /** Minted by agent-id.ts. Immutable for the life of the agent; the key for everything (store, per-agent directory, session bookkeeping). */
  id: string;
  /** Unique across all non-deleted agents (R2). Absent means the agent has never been named. */
  name?: string;
  /** R3: optional, settable at create time only. Nothing in this epic mutates it after that. */
  job?: string;
  state: AgentLifecycleState;
  /** ISO 8601. When this record was minted. */
  createdAt: string;
}

// Precedent: the pre-CNDLX-19 roster name pattern was
// `/^[a-z0-9][a-z0-9._-]*$/` (lowercase letters, digits, ".", "_", "-",
// starting with a letter or digit; that module, src/roster.ts, no longer
// exists — retired with the roster). Reused verbatim for the character
// set, with two additions that are this ticket's own call:
//   - a length bound (1-63 chars): unbounded names are an easy accidental
//     footgun (a pasted paragraph becomes "the name") and 63 mirrors the
//     common hostname/label length limit operators are already used to.
//   - nothing further beyond what the roster already enforced: no
//     case-folding, no reserved-word list (explicitly not this ticket's
//     job — see agent-set.ts).
// No tightening of the leading-character class was needed for R1: the id
// encoding (agent-id.ts) uses a leading "@", a character this pattern's
// charset excludes at every position, not just the first — so disjointness
// holds regardless of whether names may start with a digit.
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const AGENT_NAME_MAX_LENGTH = 63;

export interface NameValidationError {
  message: string;
}

export type NameValidationResult = { ok: true } | { ok: false; error: NameValidationError };

/**
 * Pure, composable name-syntax validator. Exported standalone (rather than
 * folded into a bigger "validate a rename" function) so a later CLI epic
 * can layer its own reserved-word check on top without forking these
 * rules: `const syntax = validateAgentNameSyntax(x); if (syntax.ok && RESERVED.has(x)) { ... }`.
 *
 * This function knows nothing about any store, so it cannot and does not
 * check R2 uniqueness — that requires seeing other agents (see
 * `renameAgent`/`insertAgent` in agent-set.ts).
 */
export function validateAgentNameSyntax(name: string): NameValidationResult {
  if (name.length === 0) {
    return { ok: false, error: { message: "agent name must not be empty" } };
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: { message: `agent name must be at most ${AGENT_NAME_MAX_LENGTH} characters, got ${name.length}` },
    };
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: {
        message: `agent name "${name}" must match ${AGENT_NAME_PATTERN} (lowercase letters, digits, ".", "_", "-", starting with a letter or digit)`,
      },
    };
  }
  return { ok: true };
}

/**
 * Belt-and-suspenders re-statement of R1, kept alongside the validator it
 * constrains rather than only proven at the id-encoding end (agent-id.ts).
 * Structurally this can never be reached — `AGENT_NAME_PATTERN`'s charset
 * has no "@" in it at any position, so `isAgentId(name)` is already always
 * false for anything `AGENT_NAME_PATTERN` accepts. Proven by test
 * (test/unit/agent-name-id-disjoint.test.ts), not just asserted here.
 */
export function isNameShapedLikeAnId(name: string): boolean {
  return isAgentId(name);
}
