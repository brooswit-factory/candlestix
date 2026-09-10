// The id/name resolver (CNDLX-22 / CNDLX-17): `<id-or-name>` in, agent
// out. Pure — takes an already-loaded AgentSet, does no I/O. Sibling
// stories (a daemon API/CLI, attach, argv-drift) are explicitly instructed
// to reuse this rather than write a second one.

import { isAgentId } from "./agent-id";
import { findAgentByName, type AgentSet } from "./agent-set";
import type { AgentRecord } from "./agent";

export type ResolveAgentError =
  | { kind: "not-found"; query: string }
  /**
   * Kept defensively even though it is structurally unreachable through
   * this module's own sanctioned entry points: `parseAgentSet` rejects a
   * stored file with a duplicate name (agent-set.ts), and `insertAgent` /
   * `renameAgent` both refuse to create one. Given R1 (id/name spaces
   * disjoint by construction) and R2 (name uniqueness enforced at every
   * write this codebase provides), a query can resolve to at most one
   * agent. This case exists so the type stays honest for a caller that
   * somehow ends up holding an `AgentSet` that did NOT come from
   * `parseAgentSet` or these mutators (e.g. hand-built in a test, or by
   * some future codepath this ticket cannot see) — such a caller still
   * gets a typed answer instead of an arbitrary "first match wins".
   */
  | { kind: "ambiguous"; query: string; matches: AgentRecord[] };

export type ResolveAgentResult = { ok: true; agent: AgentRecord } | { ok: false; error: ResolveAgentError };

/**
 * R1's "resolve id first, then name": a query shaped like a minted id is
 * looked up by id only, never falling through to a name scan. Given R1,
 * this ordering cannot change the *outcome* for a well-formed AgentSet (no
 * name can ever be id-shaped), but it keeps the resolution rule legible
 * without a reader having to first convince themselves disjointness holds.
 */
export function resolveAgent(agentSet: AgentSet, query: string): ResolveAgentResult {
  if (isAgentId(query)) {
    const byId = agentSet.agents[query];
    if (byId !== undefined) {
      return { ok: true, agent: byId };
    }
    return { ok: false, error: { kind: "not-found", query } };
  }

  const matches = Object.values(agentSet.agents).filter((agent) => agent.name === query);
  if (matches.length === 1) {
    return { ok: true, agent: matches[0] as AgentRecord };
  }
  if (matches.length === 0) {
    return { ok: false, error: { kind: "not-found", query } };
  }
  return { ok: false, error: { kind: "ambiguous", query, matches } };
}

// Re-exported so a caller that only needs "does a name exist" doesn't have
// to import agent-set.ts directly for it.
export { findAgentByName };
