import { describe, expect, test } from "bun:test";
import { emptyRegistry, upsertRegistryEntry, removeRegistryEntry, parseRegistry, serializeRegistry, type RegistryEntry } from "../../src/registry";

const entry: RegistryEntry = {
  name: "release-notes",
  id: "179b2dfc",
  sessionId: "179b2dfc-7069-4a4f-bfb4-bcbea162d77e",
  cwd: "/home/operator/code/candlestix",
  spawnedAt: "2026-09-02T12:00:00.000Z",
};

describe("registry mutations", () => {
  test("emptyRegistry starts with no agents", () => {
    expect(emptyRegistry()).toEqual({ version: 1, agents: {} });
  });

  test("upsertRegistryEntry adds without mutating the input", () => {
    const before = emptyRegistry();
    const after = upsertRegistryEntry(before, entry);
    expect(before.agents).toEqual({});
    expect(after.agents["release-notes"]).toEqual(entry);
  });

  test("upsertRegistryEntry overwrites an existing entry for the same name", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    const updated: RegistryEntry = { ...entry, id: "new-id", sessionId: "new-id-full-uuid" };
    const r2 = upsertRegistryEntry(r1, updated);
    expect(r2.agents["release-notes"]).toEqual(updated);
  });

  test("removeRegistryEntry drops the named entry and leaves others alone", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    const r2 = upsertRegistryEntry(r1, { ...entry, name: "other" });
    const r3 = removeRegistryEntry(r2, "release-notes");
    expect(Object.keys(r3.agents)).toEqual(["other"]);
  });

  test("removeRegistryEntry is a no-op for a name that isn't there", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    expect(removeRegistryEntry(r1, "nobody")).toEqual(r1);
  });
});

describe("parseRegistry", () => {
  test("round-trips through serializeRegistry", () => {
    const registry = upsertRegistryEntry(emptyRegistry(), entry);
    const result = parseRegistry(serializeRegistry(registry));
    expect(result).toEqual({ ok: true, registry });
  });

  test("never throws on invalid JSON", () => {
    const result = parseRegistry("{not json");
    expect(result.ok).toBe(false);
  });

  test("rejects the wrong top-level shape instead of coercing to empty", () => {
    const result = parseRegistry(JSON.stringify({ agents: [] }));
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed entry rather than silently dropping it", () => {
    const result = parseRegistry(JSON.stringify({ version: 1, agents: { x: { name: "x" } } }));
    expect(result.ok).toBe(false);
  });
});
