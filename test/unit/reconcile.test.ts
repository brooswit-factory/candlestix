import { describe, expect, test } from "bun:test";
import { decideReconcileAction, type ReconcileInputs } from "../../src/reconcile";
import type { BackgroundAgentInfo } from "../../src/agents-cli";
import type { RegistryEntry } from "../../src/registry";

const baseInputs: ReconcileInputs = {
  agentName: "release-notes",
  agentCwd: "/home/operator/code/candlestix",
  registryEntry: undefined,
  backgroundAgents: [],
  verifiedAlivePids: new Set(),
  cwdExists: true,
};

const bgAgent: BackgroundAgentInfo = {
  id: "179b2dfc",
  sessionId: "179b2dfc-7069-4a4f-bfb4-bcbea162d77e",
  cwd: "/home/operator/code/candlestix",
  startedAt: 1000,
  pid: 42,
};

const registryEntry: RegistryEntry = {
  name: "release-notes",
  id: bgAgent.id,
  sessionId: bgAgent.sessionId,
  cwd: bgAgent.cwd,
  spawnedAt: "2026-09-02T00:00:00.000Z",
};

describe("decideReconcileAction — the false-healthy paths this ticket says to hunt for", () => {
  test("no registry entry, no matching background agent, cwd exists -> spawn", () => {
    expect(decideReconcileAction(baseInputs)).toEqual({ type: "spawn" });
  });

  test("no registry entry, no matching background agent, cwd missing -> cwd-missing, never spawn", () => {
    expect(decideReconcileAction({ ...baseInputs, cwdExists: false })).toEqual({ type: "cwd-missing" });
  });

  test("registry entry matches a listed agent whose pid independently verifies alive -> heartbeat", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action).toEqual({
      type: "heartbeat",
      entry: { name: "release-notes", id: bgAgent.id, sessionId: bgAgent.sessionId, cwd: bgAgent.cwd, spawnedAt: registryEntry.spawnedAt },
    });
  });

  test("listed but claude reported no pid this cycle -> wait, NEVER heartbeat — the exact transient false-healthy trap this was built to catch", () => {
    const withoutPid: BackgroundAgentInfo = { ...bgAgent, pid: undefined };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [withoutPid],
      verifiedAlivePids: new Set(),
    });
    expect(action.type).toBe("wait");
  });

  test("listed with a pid that does NOT independently verify alive -> wait, never heartbeat", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set(), // 42 not in the verified set
    });
    expect(action.type).toBe("wait");
  });

  test("registry points at a session no longer listed, but cwd-adoption finds a different live one -> heartbeat (registry self-heals), with the NEW session's own spawnedAt — never the dead predecessor's", () => {
    const staleRegistryEntry: RegistryEntry = { ...registryEntry, id: "dead-id", sessionId: "dead-session" };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: staleRegistryEntry,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action).toEqual({
      type: "heartbeat",
      entry: {
        name: "release-notes",
        id: bgAgent.id,
        sessionId: bgAgent.sessionId,
        cwd: bgAgent.cwd,
        spawnedAt: new Date(bgAgent.startedAt).toISOString(), // NOT staleRegistryEntry.spawnedAt — different session
      },
    });
  });

  test("a fresh spawn that replaced a genuinely-ended session gets its OWN spawnedAt, not the dead predecessor's, even though a registry entry for the name still exists", () => {
    const deadPredecessor: RegistryEntry = { ...registryEntry, sessionId: "a-session-that-ended-long-ago", spawnedAt: "2020-01-01T00:00:00.000Z" };
    const freshSession: BackgroundAgentInfo = { ...bgAgent, sessionId: "brand-new-session", startedAt: 5000, pid: 99 };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: deadPredecessor,
      backgroundAgents: [freshSession],
      verifiedAlivePids: new Set([99]),
    });
    expect(action.type).toBe("heartbeat");
    if (action.type === "heartbeat") {
      expect(action.entry.sessionId).toBe("brand-new-session");
      expect(action.entry.spawnedAt).toBe(new Date(5000).toISOString());
      expect(action.entry.spawnedAt).not.toBe(deadPredecessor.spawnedAt);
    }
  });

  test("no registry entry at all, but a live session already exists at this cwd -> adopt it, never spawn a duplicate", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: undefined,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action.type).toBe("heartbeat");
  });

  test("registry entry present but genuinely gone (not listed, no cwd match either) and cwd still exists -> spawn a replacement", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [],
      verifiedAlivePids: new Set(),
      cwdExists: true,
    });
    expect(action).toEqual({ type: "spawn" });
  });

  test("registry entry present but genuinely gone and cwd missing -> cwd-missing, never spawn into a dead directory", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [],
      verifiedAlivePids: new Set(),
      cwdExists: false,
    });
    expect(action).toEqual({ type: "cwd-missing" });
  });

  test("a background agent for a DIFFERENT cwd never gets adopted for this one", () => {
    const elsewhere: BackgroundAgentInfo = { ...bgAgent, cwd: "/somewhere/else" };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: undefined,
      backgroundAgents: [elsewhere],
      verifiedAlivePids: new Set([42]),
      cwdExists: true,
    });
    expect(action).toEqual({ type: "spawn" });
  });
});
