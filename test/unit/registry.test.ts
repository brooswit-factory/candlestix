import { describe, expect, test } from "bun:test";
import { emptyRegistry, upsertRegistryEntry, removeRegistryEntry, parseRegistry, serializeRegistry, type RegistryEntry } from "../../src/registry";

const entry: RegistryEntry = {
  agentId: "@0000000000releasnts",
  agentName: "release-notes",
  sessionShortId: "179b2dfc",
  sessionId: "179b2dfc-7069-4a4f-bfb4-bcbea162d77e",
  cwd: "/home/operator/.local/state/candlestix/agents/@0000000000releasnts",
  spawnedAt: "2026-09-02T12:00:00.000Z",
};

describe("registry mutations", () => {
  test("emptyRegistry starts with no agents", () => {
    expect(emptyRegistry()).toEqual({ version: 2, agents: {} });
  });

  test("upsertRegistryEntry adds without mutating the input, keyed by agentId (T4) — not name", () => {
    const before = emptyRegistry();
    const after = upsertRegistryEntry(before, entry);
    expect(before.agents).toEqual({});
    expect(after.agents[entry.agentId]).toEqual(entry);
  });

  test("upsertRegistryEntry overwrites an existing entry for the same agentId", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    const updated: RegistryEntry = { ...entry, sessionShortId: "new-id", sessionId: "new-id-full-uuid" };
    const r2 = upsertRegistryEntry(r1, updated);
    expect(r2.agents[entry.agentId]).toEqual(updated);
  });

  test("removeRegistryEntry drops the keyed entry and leaves others alone", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    const other: RegistryEntry = { ...entry, agentId: "@0000000001other0000" };
    const r2 = upsertRegistryEntry(r1, other);
    const r3 = removeRegistryEntry(r2, entry.agentId);
    expect(Object.keys(r3.agents)).toEqual([other.agentId]);
  });

  test("removeRegistryEntry is a no-op for an agentId that isn't there", () => {
    const r1 = upsertRegistryEntry(emptyRegistry(), entry);
    expect(removeRegistryEntry(r1, "@nobody0000000000000")).toEqual(r1);
  });

  test("a nameless (blank) agent's entry omits agentName entirely — display only, never required", () => {
    const { agentName: _agentName, ...blank } = entry;
    const r = upsertRegistryEntry(emptyRegistry(), blank);
    expect(r.agents[entry.agentId]?.agentName).toBeUndefined();
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
    expect(result).toEqual({
      ok: false,
      kind: "malformed",
      error: `registry does not have the expected { version, agents: {...} } shape`,
    });
  });

  test("rejects a malformed v2 entry rather than silently dropping it", () => {
    const result = parseRegistry(JSON.stringify({ version: 2, agents: { x: { agentId: "x" } } }));
    expect(result).toEqual({ ok: false, kind: "malformed", error: `registry entry "x" is malformed` });
  });

  test("rejects an entry keyed under a different id than its own agentId field", () => {
    const result = parseRegistry(
      JSON.stringify({
        version: 2,
        agents: { wrongkey: { ...entry, agentId: entry.agentId } },
      })
    );
    expect(result).toEqual({ ok: false, kind: "malformed", error: `registry entry "wrongkey" is malformed` });
  });

  test("rejects an unknown version distinctly from a recognised legacy one", () => {
    const result = parseRegistry(JSON.stringify({ version: 3, agents: {} }));
    expect(result).toEqual({ ok: false, kind: "malformed", error: `registry has unknown version 3, expected 2` });
  });

  describe("CNDLX-19 T4 — the pre-CNDLX-19, name-keyed (version 1) shape is recognised as LEGACY, distinct from malformed", () => {
    test("a genuine pre-CNDLX-19 file (version 1, old entry shape) is reported as legacy, not malformed", () => {
      const legacy = {
        version: 1,
        agents: {
          "release-notes": {
            name: "release-notes",
            id: "179b2dfc",
            sessionId: "179b2dfc-7069-4a4f-bfb4-bcbea162d77e",
            cwd: "/home/operator/code/candlestix",
            spawnedAt: "2026-09-02T00:00:00.000Z",
          },
        },
      };
      const result = parseRegistry(JSON.stringify(legacy));
      expect(result).toEqual({ ok: false, kind: "legacy" });
    });

    test("an empty version-1 registry is also recognised as legacy (vacuously all entries match the old shape)", () => {
      const result = parseRegistry(JSON.stringify({ version: 1, agents: {} }));
      expect(result).toEqual({ ok: false, kind: "legacy" });
    });

    test("a version-1 file that does NOT match the old shape is malformed, not legacy — a probe that would wrongly call every v1 file legacy is exactly the false-pass this test guards against", () => {
      const result = parseRegistry(JSON.stringify({ version: 1, agents: { x: { garbage: true } } }));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.kind).toBe("malformed");
    });
  });
});
