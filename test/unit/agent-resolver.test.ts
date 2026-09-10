import { describe, expect, test } from "bun:test";
import { resolveAgent } from "../../src/agent-resolver";
import { emptyAgentSet, insertAgent, type AgentSet } from "../../src/agent-set";
import { mintAgentId } from "../../src/agent-id";
import type { AgentRecord } from "../../src/agent";

function id(seed: number): string {
  return mintAgentId({ now: () => new Date(1_726_000_000_000 + seed), random: () => (seed % 32) / 32 });
}

function record(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { state: "off", createdAt: "2026-09-09T00:00:00.000Z", ...overrides };
}

describe("resolveAgent", () => {
  test("resolves by id", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    expect(resolveAgent(inserted.agentSet, a.id)).toEqual({ ok: true, agent: a });
  });

  test("resolves by name", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    expect(resolveAgent(inserted.agentSet, "alpha")).toEqual({ ok: true, agent: a });
  });

  test("id wins: an id-shaped query is resolved by id even though it could never also be a name (R1)", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    // Querying with the id, not the name, must hit the id branch.
    const result = resolveAgent(inserted.agentSet, a.id);
    expect(result).toEqual({ ok: true, agent: a });
  });

  test("typed not-found for an id-shaped query that matches no agent", () => {
    const missingId = id(999);
    const result = resolveAgent(emptyAgentSet(), missingId);
    expect(result).toEqual({ ok: false, error: { kind: "not-found", query: missingId } });
  });

  test("typed not-found for a name-shaped query that matches no agent", () => {
    const result = resolveAgent(emptyAgentSet(), "nobody");
    expect(result).toEqual({ ok: false, error: { kind: "not-found", query: "nobody" } });
  });

  test("an unnamed agent is reachable only by id, not by any name query", () => {
    const a = record({ id: id(1) });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    expect(resolveAgent(inserted.agentSet, a.id)).toEqual({ ok: true, agent: a });
    expect(resolveAgent(inserted.agentSet, "a").ok).toBe(false);
  });

  test("ambiguous: ok:false with both matches, for an AgentSet that did not come through this module's own invariant-enforcing writers", () => {
    // Deliberately hand-built, bypassing insertAgent/renameAgent and
    // parseAgentSet, to exercise the defensive branch documented on
    // ResolveAgentError — see agent-resolver.ts for why this case cannot
    // arise through any sanctioned write path this codebase provides.
    const a = record({ id: id(1), name: "shared" });
    const b = record({ id: id(2), name: "shared" });
    const handBuilt: AgentSet = { version: 1, agents: { [a.id]: a, [b.id]: b }, retiredIds: [] };

    const result = resolveAgent(handBuilt, "shared");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("ambiguous");
    if (result.error.kind !== "ambiguous") return;
    expect(result.error.matches).toHaveLength(2);
    expect(result.error.matches).toEqual(expect.arrayContaining([a, b]));
  });
});
