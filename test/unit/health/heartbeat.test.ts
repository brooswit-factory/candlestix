import { describe, expect, test } from "bun:test";
import { createHeartbeatStore } from "../../../src/health/heartbeat";

describe("createHeartbeatStore", () => {
  test("an untracked subject is reported as untracked, not as a stale one", () => {
    const store = createHeartbeatStore();
    expect(store.getHeartbeat("nobody-ever-registered-this")).toEqual({
      tracked: false,
      lastHeartbeat: null,
    });
  });

  test("registerSubject marks a subject tracked with no heartbeat yet", () => {
    const store = createHeartbeatStore();
    store.registerSubject("agent-a");
    expect(store.getHeartbeat("agent-a")).toEqual({ tracked: true, lastHeartbeat: null });
  });

  test("recordHeartbeat implicitly tracks a subject that was never registered", () => {
    const store = createHeartbeatStore();
    const at = new Date("2026-01-01T00:00:00.000Z");
    store.recordHeartbeat("agent-b", at);
    expect(store.getHeartbeat("agent-b")).toEqual({ tracked: true, lastHeartbeat: at });
  });

  test("recordHeartbeat overwrites the previous heartbeat", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("agent-c", new Date("2026-01-01T00:00:00.000Z"));
    const later = new Date("2026-01-01T00:05:00.000Z");
    store.recordHeartbeat("agent-c", later);
    expect(store.getHeartbeat("agent-c")).toEqual({ tracked: true, lastHeartbeat: later });
  });

  test("listTrackedSubjects lists every subject registered or heartbeaten, and nothing else", () => {
    const store = createHeartbeatStore();
    store.registerSubject("agent-d");
    store.recordHeartbeat("agent-e", new Date());
    expect(store.listTrackedSubjects().sort()).toEqual(["agent-d", "agent-e"]);
  });
});
