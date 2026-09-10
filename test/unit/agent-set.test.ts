import { describe, expect, test } from "bun:test";
import {
  deleteAgent,
  emptyAgentSet,
  findAgentByName,
  insertAgent,
  parseAgentSet,
  renameAgent,
  serializeAgentSet,
  type AgentSet,
} from "../../src/agent-set";
import type { AgentRecord } from "../../src/agent";
import { mintAgentId } from "../../src/agent-id";

function id(seed: number): string {
  return mintAgentId({ now: () => new Date(1_726_000_000_000 + seed), random: () => (seed % 32) / 32 });
}

function record(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { state: "off", createdAt: "2026-09-09T00:00:00.000Z", ...overrides };
}

describe("parseAgentSet — malformed vs empty are distinct", () => {
  test("parses a well-formed set", () => {
    const a = record({ id: id(1), name: "alpha", state: "on" });
    const source = serializeAgentSet({ version: 1, agents: { [a.id]: a }, retiredIds: [] });
    const result = parseAgentSet(source);
    expect(result).toEqual({ ok: true, agentSet: { version: 1, agents: { [a.id]: a }, retiredIds: [] } });
  });

  test("an empty set parses ok — this is 'no agents yet', not an error", () => {
    const result = parseAgentSet(serializeAgentSet(emptyAgentSet()));
    expect(result).toEqual({ ok: true, agentSet: emptyAgentSet() });
  });

  test("invalid JSON is reported as a distinct error, never coerced to empty", () => {
    const result = parseAgentSet("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("wrong top-level shape is reported as an error, never coerced to empty", () => {
    expect(parseAgentSet(JSON.stringify({ version: 2, agents: {}, retiredIds: [] })).ok).toBe(false);
    expect(parseAgentSet(JSON.stringify({ version: 1, agents: [], retiredIds: [] })).ok).toBe(false);
    expect(parseAgentSet(JSON.stringify({ version: 1, agents: {} })).ok).toBe(false); // missing retiredIds
    expect(parseAgentSet("[]").ok).toBe(false);
    expect(parseAgentSet("null").ok).toBe(false);
  });

  test("a malformed entry names the offending key in the error", () => {
    const result = parseAgentSet(JSON.stringify({ version: 1, agents: { [id(1)]: { id: id(1) } }, retiredIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(id(1));
  });

  test("an entry keyed under a different id than its own 'id' field is rejected", () => {
    const a = record({ id: id(1) });
    const result = parseAgentSet(JSON.stringify({ version: 1, agents: { [id(2)]: a }, retiredIds: [] }));
    expect(result.ok).toBe(false);
  });

  test("a duplicate name across two entries is rejected, distinct from 'empty'", () => {
    const a = record({ id: id(1), name: "dup" });
    const b = record({ id: id(2), name: "dup" });
    const result = parseAgentSet(JSON.stringify({ version: 1, agents: { [a.id]: a, [b.id]: b }, retiredIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("dup");
      expect(result.error).toContain(a.id);
      expect(result.error).toContain(b.id);
    }
  });

  test("an id listed as both active and retired is rejected (R4 disjointness)", () => {
    const a = record({ id: id(1) });
    const result = parseAgentSet(JSON.stringify({ version: 1, agents: { [a.id]: a }, retiredIds: [a.id] }));
    expect(result.ok).toBe(false);
  });

  test("a non-id-shaped retired entry is rejected", () => {
    const result = parseAgentSet(JSON.stringify({ version: 1, agents: {}, retiredIds: ["not-an-id"] }));
    expect(result.ok).toBe(false);
  });
});

describe("insertAgent", () => {
  test("adds a fresh unnamed agent", () => {
    const a = record({ id: id(1) });
    const result = insertAgent(emptyAgentSet(), a);
    expect(result).toEqual({ ok: true, agentSet: { version: 1, agents: { [a.id]: a }, retiredIds: [] } });
  });

  test("refuses an id already present in the set", () => {
    const a = record({ id: id(1) });
    const inserted = insertAgent(emptyAgentSet(), a);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const again = insertAgent(inserted.agentSet, record({ id: id(1) }));
    expect(again).toEqual({ ok: false, error: { kind: "id-already-used" } });
  });

  test("refuses a retired id (R4: a re-mint, however unlucky, can never collide)", () => {
    const a = record({ id: id(1) });
    const inserted = insertAgent(emptyAgentSet(), a);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const deleted = deleteAgent(inserted.agentSet, a.id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const reinsert = insertAgent(deleted.agentSet, record({ id: a.id }));
    expect(reinsert).toEqual({ ok: false, error: { kind: "id-retired" } });
  });

  test("refuses a name already held by another agent at creation time, naming the holder", () => {
    const a = record({ id: id(1), name: "taken" });
    const inserted = insertAgent(emptyAgentSet(), a);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const result = insertAgent(inserted.agentSet, record({ id: id(2), name: "taken" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("name-taken");
    if (result.error.kind !== "name-taken") return;
    expect(result.error.holder).toEqual(a);
    expect(result.error.message).toContain(a.id);
  });

  test("refuses a syntactically invalid name at creation", () => {
    const result = insertAgent(emptyAgentSet(), record({ id: id(1), name: "Not Valid" }));
    expect(result).toEqual({ ok: false, error: { kind: "invalid-name", message: expect.any(String) } });
  });
});

describe("renameAgent — R2", () => {
  test("renames onto a free name", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const result = renameAgent(inserted.agentSet, a.id, "renamed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentSet.agents[a.id]?.name).toBe("renamed");
  });

  test("refuses renaming onto a name held by a DIFFERENT agent, naming the current holder in the message", () => {
    const a = record({ id: id(1), name: "alpha" });
    const b = record({ id: id(2), name: "beta" });
    let set = emptyAgentSet();
    const insA = insertAgent(set, a);
    if (!insA.ok) throw new Error("setup");
    set = insA.agentSet;
    const insB = insertAgent(set, b);
    if (!insB.ok) throw new Error("setup");
    set = insB.agentSet;

    const result = renameAgent(set, b.id, "alpha");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("name-taken");
    if (result.error.kind !== "name-taken") return;
    expect(result.error.holder).toEqual(a);
    expect(result.error.message).toContain("alpha");
    expect(result.error.message).toContain(a.id); // names the current holder
  });

  test("renaming onto the name the SAME agent already holds is a no-op success, not a refusal", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    const result = renameAgent(inserted.agentSet, a.id, "alpha");
    expect(result).toEqual({ ok: true, agentSet: inserted.agentSet });
  });

  test("refuses renaming an agent that does not exist", () => {
    const result = renameAgent(emptyAgentSet(), id(1), "alpha");
    expect(result).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  test("an archived agent still holds its name and still refuses a collision (R2: archived agents keep holding their name)", () => {
    const archived = record({ id: id(1), name: "alpha", state: "archived" });
    const other = record({ id: id(2) });
    let set = emptyAgentSet();
    const insA = insertAgent(set, archived);
    if (!insA.ok) throw new Error("setup");
    set = insA.agentSet;
    const insB = insertAgent(set, other);
    if (!insB.ok) throw new Error("setup");
    set = insB.agentSet;

    const result = renameAgent(set, other.id, "alpha");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("name-taken");
    if (result.error.kind !== "name-taken") return;
    expect(result.error.holder.id).toBe(archived.id);
  });
});

describe("deleteAgent — R4 retirement, R2 name is freed", () => {
  test("removes the agent and records its id as retired", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    const result = deleteAgent(inserted.agentSet, a.id);
    expect(result).toEqual({ ok: true, agentSet: { version: 1, agents: {}, retiredIds: [a.id] } });
  });

  test("frees the name: a new agent can take the deleted agent's old name", () => {
    const a = record({ id: id(1), name: "alpha" });
    const inserted = insertAgent(emptyAgentSet(), a);
    if (!inserted.ok) throw new Error("setup");
    const deleted = deleteAgent(inserted.agentSet, a.id);
    if (!deleted.ok) throw new Error("setup");
    expect(findAgentByName(deleted.agentSet, "alpha")).toBeUndefined();
    const reinserted = insertAgent(deleted.agentSet, record({ id: id(2), name: "alpha" }));
    expect(reinserted.ok).toBe(true);
  });

  test("refuses deleting an agent that does not exist", () => {
    const result = deleteAgent(emptyAgentSet(), id(1));
    expect(result).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

describe("serializeAgentSet / parseAgentSet round-trip", () => {
  test("round-trips an interesting set (named, unnamed, job, archived, retired ids)", () => {
    const a = record({ id: id(1), name: "alpha", job: "watch the build", state: "on" });
    const b = record({ id: id(2), state: "off" });
    const c = record({ id: id(3), name: "gamma", state: "archived" });
    const set: AgentSet = { version: 1, agents: { [a.id]: a, [b.id]: b, [c.id]: c }, retiredIds: [id(4), id(5)] };
    const parsed = parseAgentSet(serializeAgentSet(set));
    expect(parsed).toEqual({ ok: true, agentSet: set });
  });
});
