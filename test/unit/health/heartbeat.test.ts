import { describe, expect, test } from "bun:test";
import { createHeartbeatStore } from "../../../src/health/heartbeat";

describe("createHeartbeatStore", () => {
  test("an untracked subject is reported as untracked, not as a stale one", () => {
    const store = createHeartbeatStore();
    expect(store.getHeartbeat("nobody-ever-registered-this")).toEqual({
      tracked: false,
      lastHeartbeat: null,
      displayName: undefined,
    });
  });

  test("registerSubject marks a subject tracked with no heartbeat yet", () => {
    const store = createHeartbeatStore();
    store.registerSubject("agent-a");
    expect(store.getHeartbeat("agent-a")).toEqual({ tracked: true, lastHeartbeat: null, displayName: undefined });
  });

  test("recordHeartbeat implicitly tracks a subject that was never registered", () => {
    const store = createHeartbeatStore();
    const at = new Date("2026-01-01T00:00:00.000Z");
    store.recordHeartbeat("agent-b", at);
    expect(store.getHeartbeat("agent-b")).toEqual({ tracked: true, lastHeartbeat: at, displayName: undefined });
  });

  test("recordHeartbeat overwrites the previous heartbeat", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("agent-c", new Date("2026-01-01T00:00:00.000Z"));
    const later = new Date("2026-01-01T00:05:00.000Z");
    store.recordHeartbeat("agent-c", later);
    expect(store.getHeartbeat("agent-c")).toEqual({ tracked: true, lastHeartbeat: later, displayName: undefined });
  });

  test("listTrackedSubjects lists every subject registered or heartbeaten, and nothing else", () => {
    const store = createHeartbeatStore();
    store.registerSubject("agent-d");
    store.recordHeartbeat("agent-e", new Date());
    expect(store.listTrackedSubjects().sort()).toEqual(["agent-d", "agent-e"]);
  });

  describe("CNDLX-19 T4: displayName is carried for legibility, never used as a key", () => {
    test("registerSubject records a display name", () => {
      const store = createHeartbeatStore();
      store.registerSubject("@01agentid", "release-notes");
      expect(store.getHeartbeat("@01agentid").displayName).toBe("release-notes");
    });

    test("recordHeartbeat records a display name when the subject is new", () => {
      const store = createHeartbeatStore();
      store.recordHeartbeat("@01agentid", new Date(), "release-notes");
      expect(store.getHeartbeat("@01agentid").displayName).toBe("release-notes");
    });

    test("a later call without a display name does not clear a previously-recorded one", () => {
      const store = createHeartbeatStore();
      store.registerSubject("@01agentid", "release-notes");
      store.recordHeartbeat("@01agentid", new Date());
      expect(store.getHeartbeat("@01agentid").displayName).toBe("release-notes");
    });

    test("a rename is reflected by a later registerSubject/recordHeartbeat call carrying the new name", () => {
      const store = createHeartbeatStore();
      store.registerSubject("@01agentid", "old-name");
      store.registerSubject("@01agentid", "new-name");
      expect(store.getHeartbeat("@01agentid").displayName).toBe("new-name");
    });
  });

  describe("CNDLX-19 T3: unregisterSubject — the removal verb that did not exist before this ticket", () => {
    test("removes a tracked subject entirely — it goes back to reporting untracked, not stale", () => {
      const store = createHeartbeatStore();
      store.recordHeartbeat("agent-f", new Date());
      expect(store.getHeartbeat("agent-f").tracked).toBe(true);

      store.unregisterSubject("agent-f");

      expect(store.getHeartbeat("agent-f")).toEqual({ tracked: false, lastHeartbeat: null, displayName: undefined });
      expect(store.listTrackedSubjects()).not.toContain("agent-f");
    });

    test("is idempotent — unregistering a subject that was never tracked, or already unregistered, is a no-op, not an error", () => {
      const store = createHeartbeatStore();
      expect(() => store.unregisterSubject("never-existed")).not.toThrow();
      store.recordHeartbeat("agent-g", new Date());
      store.unregisterSubject("agent-g");
      expect(() => store.unregisterSubject("agent-g")).not.toThrow();
      expect(store.listTrackedSubjects()).toEqual([]);
    });

    test("only removes the named subject, leaving every other tracked subject untouched", () => {
      const store = createHeartbeatStore();
      store.registerSubject("keep-a");
      store.registerSubject("remove-me");
      store.registerSubject("keep-b");
      store.unregisterSubject("remove-me");
      expect(store.listTrackedSubjects().sort()).toEqual(["keep-a", "keep-b"]);
    });
  });
});
