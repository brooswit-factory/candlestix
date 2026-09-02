import { describe, expect, test } from "bun:test";
import { evaluateStaleness } from "../../../src/health/staleness";

const THRESHOLD_MS = 60_000;
const NOW = new Date("2026-01-01T00:10:00.000Z");

describe("evaluateStaleness", () => {
  // 1. Fresh heartbeat -> healthy. Fails if a recent heartbeat is ever
  // reported as anything but healthy.
  test("a heartbeat well within the threshold is healthy", () => {
    const lastHeartbeat = new Date(NOW.getTime() - 1_000);
    expect(evaluateStaleness({ tracked: true, lastHeartbeat }, NOW, THRESHOLD_MS)).toEqual({
      kind: "healthy",
      lastHeartbeat,
    });
  });

  // 2. Heartbeat older than threshold -> stale. Fails if an old heartbeat
  // is ever reported healthy or unknown.
  test("a heartbeat older than the threshold is stale", () => {
    const lastHeartbeat = new Date(NOW.getTime() - THRESHOLD_MS - 1);
    expect(evaluateStaleness({ tracked: true, lastHeartbeat }, NOW, THRESHOLD_MS)).toEqual({
      kind: "stale",
      lastHeartbeat,
    });
  });

  // 3. Tracked subject, no heartbeat ever recorded -> stale, not healthy.
  // Fails if "never started" is ever reported as healthy (or unknown —
  // this subject IS tracked).
  test("a tracked subject with no heartbeat ever recorded is stale, never healthy", () => {
    expect(evaluateStaleness({ tracked: true, lastHeartbeat: null }, NOW, THRESHOLD_MS)).toEqual({
      kind: "stale",
      lastHeartbeat: null,
    });
  });

  // 4. Untracked subject -> unknown, specifically not stale. Fails if an
  // untracked lookup is ever reported as a definite stale or healthy
  // verdict.
  test("an untracked subject is unknown, never a definite stale or healthy verdict", () => {
    const verdict = evaluateStaleness({ tracked: false, lastHeartbeat: null }, NOW, THRESHOLD_MS);
    expect(verdict).toEqual({ kind: "unknown" });
    expect(verdict.kind).not.toBe("stale");
    expect(verdict.kind).not.toBe("healthy");
  });

  // 5. Boundary exactly at the threshold. Decision: exactly-at-threshold
  // is still healthy; staleness requires the age to exceed the threshold.
  // Fails if the boundary sample flips to stale, silently changing which
  // side "exactly the threshold" falls on.
  describe("boundary at exactly the threshold", () => {
    test("age === thresholdMs is healthy (staleness requires exceeding the threshold)", () => {
      const lastHeartbeat = new Date(NOW.getTime() - THRESHOLD_MS);
      expect(evaluateStaleness({ tracked: true, lastHeartbeat }, NOW, THRESHOLD_MS).kind).toBe("healthy");
    });

    test("age === thresholdMs + 1 is stale", () => {
      const lastHeartbeat = new Date(NOW.getTime() - THRESHOLD_MS - 1);
      expect(evaluateStaleness({ tracked: true, lastHeartbeat }, NOW, THRESHOLD_MS).kind).toBe("stale");
    });
  });
});
