import { describe, expect, test } from "bun:test";
import { decideReconcileAction, type ReconcileInputs } from "../../src/reconcile";
import type { BackgroundAgentInfo } from "../../src/agents-cli";
import type { RegistryEntry } from "../../src/registry";

const AGENT_ID = "@01m24dm7tbg3wxc8j9x0";
const AGENT_DIR = "/home/operator/.local/state/candlestix/agents/@01m24dm7tbg3wxc8j9x0";

const baseInputs: ReconcileInputs = {
  agentId: AGENT_ID,
  agentName: "release-notes",
  state: "on",
  agentDir: AGENT_DIR,
  registryEntry: undefined,
  backgroundAgents: [],
  verifiedAlivePids: new Set(),
  dirExists: true,
};

const bgAgent: BackgroundAgentInfo = {
  id: "179b2dfc",
  sessionId: "179b2dfc-7069-4a4f-bfb4-bcbea162d77e",
  cwd: AGENT_DIR,
  startedAt: 1000,
  pid: 42,
};

const registryEntry: RegistryEntry = {
  agentId: AGENT_ID,
  agentName: "release-notes",
  sessionShortId: bgAgent.id,
  sessionId: bgAgent.sessionId,
  cwd: bgAgent.cwd,
  spawnedAt: "2026-09-02T00:00:00.000Z",
};

describe("decideReconcileAction — state === \"on\" (unchanged spawn/wait/heartbeat behaviour, re-keyed to id/directory)", () => {
  test("no registry entry, no matching background agent, dir exists -> spawn", () => {
    expect(decideReconcileAction(baseInputs)).toEqual({ type: "spawn" });
  });

  test("no registry entry, no matching background agent, dir missing -> dir-missing, never spawn", () => {
    expect(decideReconcileAction({ ...baseInputs, dirExists: false })).toEqual({ type: "dir-missing" });
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
      entry: {
        agentId: AGENT_ID,
        agentName: "release-notes",
        sessionShortId: bgAgent.id,
        sessionId: bgAgent.sessionId,
        cwd: bgAgent.cwd,
        spawnedAt: registryEntry.spawnedAt,
      },
    });
  });

  test("a nameless (blank) agent's heartbeat entry omits agentName entirely", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      agentName: undefined,
      registryEntry: undefined,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action.type).toBe("heartbeat");
    if (action.type === "heartbeat") {
      expect(action.entry.agentName).toBeUndefined();
    }
  });

  test("listed but claude reported no pid this cycle -> wait, NEVER heartbeat", () => {
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

  test("registry points at a session no longer listed, but directory-adoption finds a different live one -> heartbeat (registry self-heals), with the NEW session's own spawnedAt", () => {
    const staleRegistryEntry: RegistryEntry = { ...registryEntry, sessionShortId: "dead-id", sessionId: "dead-session" };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: staleRegistryEntry,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action).toEqual({
      type: "heartbeat",
      entry: {
        agentId: AGENT_ID,
        agentName: "release-notes",
        sessionShortId: bgAgent.id,
        sessionId: bgAgent.sessionId,
        cwd: bgAgent.cwd,
        spawnedAt: new Date(bgAgent.startedAt).toISOString(), // NOT staleRegistryEntry.spawnedAt — different session
      },
    });
  });

  test("no registry entry at all, but a live session already exists under this agent's directory -> adopt it, never spawn a duplicate", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: undefined,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action.type).toBe("heartbeat");
  });

  test("registry entry present but genuinely gone (not listed, no directory match either) and dir still exists -> spawn a replacement", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [],
      verifiedAlivePids: new Set(),
      dirExists: true,
    });
    expect(action).toEqual({ type: "spawn" });
  });

  test("registry entry present but genuinely gone and dir missing -> dir-missing, never spawn into a dead directory", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry,
      backgroundAgents: [],
      verifiedAlivePids: new Set(),
      dirExists: false,
    });
    expect(action).toEqual({ type: "dir-missing" });
  });

  test("a background agent under a DIFFERENT directory never gets adopted for this one", () => {
    const elsewhere: BackgroundAgentInfo = { ...bgAgent, cwd: "/somewhere/else" };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: undefined,
      backgroundAgents: [elsewhere],
      verifiedAlivePids: new Set([42]),
      dirExists: true,
    });
    expect(action).toEqual({ type: "spawn" });
  });

  test("T5: more than one live session matches this agent's directory exactly and none matches the registry -> wait, never adopt ambiguously, never spawn a duplicate", () => {
    const second: BackgroundAgentInfo = { ...bgAgent, id: "another", sessionId: "another-session", pid: 43 };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry: undefined,
      backgroundAgents: [bgAgent, second],
      verifiedAlivePids: new Set([42, 43]),
      dirExists: true,
    });
    expect(action.type).toBe("wait");
    if (action.type === "wait") {
      expect(action.reason).toContain("179b2dfc");
      expect(action.reason).toContain("another");
    }
  });

  test("an identity match still wins over an ambiguous directory match — registry breaks the tie", () => {
    const second: BackgroundAgentInfo = { ...bgAgent, id: "another", sessionId: "another-session", pid: 43 };
    const action = decideReconcileAction({
      ...baseInputs,
      registryEntry, // matches bgAgent by sessionId
      backgroundAgents: [bgAgent, second],
      verifiedAlivePids: new Set([42, 43]),
      dirExists: true,
    });
    expect(action.type).toBe("heartbeat");
  });
});

describe("decideReconcileAction — CNDLX-19 T1: state !== \"on\" is NEVER spawned, by any path", () => {
  for (const state of ["off", "archived"] as const) {
    test(`state "${state}", no live session under the directory -> not-subject (quiet, nothing to do), never spawn`, () => {
      const action = decideReconcileAction({ ...baseInputs, state, registryEntry: undefined, backgroundAgents: [], dirExists: true });
      expect(action).toEqual({ type: "not-subject" });
    });

    test(`state "${state}", no live session, dir does not even exist -> STILL not-subject, never dir-missing, never spawn`, () => {
      // Directory existence is only ever consulted on the "on" spawn path
      // — an off/archived agent's directory not existing is not this
      // function's problem to report.
      const action = decideReconcileAction({ ...baseInputs, state, registryEntry: undefined, backgroundAgents: [], dirExists: false });
      expect(action).toEqual({ type: "not-subject" });
    });

    test(`CNDLX-19 T2: state "${state}" WITH a live session under its directory anyway -> unexpected-session, reports only, never spawns and (by construction — no such action type exists) never stops anything`, () => {
      const action = decideReconcileAction({ ...baseInputs, state, registryEntry: undefined, backgroundAgents: [bgAgent], verifiedAlivePids: new Set([42]) });
      expect(action.type).toBe("unexpected-session");
      if (action.type === "unexpected-session") {
        expect(action.sessionIds).toEqual([bgAgent.id]);
        expect(action.reason).toContain(state);
      }
    });

    test(`state "${state}" reports EVERY live session under the directory, not just the first, when more than one exists`, () => {
      const second: BackgroundAgentInfo = { ...bgAgent, id: "second-session", sessionId: "second-session-full" };
      const action = decideReconcileAction({
        ...baseInputs,
        state,
        registryEntry: undefined,
        backgroundAgents: [bgAgent, second],
        verifiedAlivePids: new Set([42]),
      });
      expect(action.type).toBe("unexpected-session");
      if (action.type === "unexpected-session") {
        expect(action.sessionIds.sort()).toEqual([bgAgent.id, second.id].sort());
      }
    });

    test(`state "${state}" ignores a registry entry entirely — a stale registry pointing elsewhere changes nothing about the verdict`, () => {
      const action = decideReconcileAction({ ...baseInputs, state, registryEntry, backgroundAgents: [], dirExists: true });
      expect(action).toEqual({ type: "not-subject" });
    });

    test(`state "${state}" never reaches "spawn" even when the directory exists and nothing else is listed — the exact pre-CNDLX-19 bug this ticket fixes`, () => {
      const action = decideReconcileAction({ ...baseInputs, state, registryEntry: undefined, backgroundAgents: [], dirExists: true });
      expect(action.type).not.toBe("spawn");
    });
  }
});

describe("CNDLX-19 T7 (H3): the loop obeys the recorded state exactly, with no heuristic override", () => {
  test("state says \"on\" but nothing is listed at all — the loop spawns, it does not infer the record is wrong and refuse", () => {
    const action = decideReconcileAction({ ...baseInputs, state: "on", registryEntry: undefined, backgroundAgents: [], dirExists: true });
    expect(action).toEqual({ type: "spawn" });
  });

  test("state says \"off\" but a session is genuinely alive — the loop does not infer the record is stale and touch the session; it only reports", () => {
    const action = decideReconcileAction({
      ...baseInputs,
      state: "off",
      registryEntry: undefined,
      backgroundAgents: [bgAgent],
      verifiedAlivePids: new Set([42]),
    });
    expect(action.type).toBe("unexpected-session");
  });
});
