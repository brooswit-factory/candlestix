import { describe, expect, test } from "bun:test";
import { parseAgentsJson, listBackgroundAgents } from "../../src/agents-cli";

describe("parseAgentsJson", () => {
  test("keeps only kind: background entries", () => {
    const raw = JSON.stringify([
      { pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "s1", name: "x" },
      { pid: 2, id: "abc", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2", name: "abc" },
    ]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "abc", sessionId: "s2", cwd: "/b", startedAt: 2, pid: 2 }]);
  });

  test("a background entry with no pid field parses with pid: undefined — the observed transient case, never coerced away", () => {
    const raw = JSON.stringify([{ id: "abc", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2", state: "blocked" }]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "abc", sessionId: "s2", cwd: "/b", startedAt: 2, pid: undefined }]);
  });

  test("skips a malformed individual entry rather than failing the whole parse", () => {
    const raw = JSON.stringify([
      { id: "good", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2" },
      { id: "bad", kind: "background" }, // missing cwd/startedAt/sessionId
    ]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "good", sessionId: "s2", cwd: "/b", startedAt: 2, pid: undefined }]);
  });

  test("empty array in, empty array out", () => {
    expect(parseAgentsJson("[]")).toEqual([]);
  });

  test("throws, does not return [], on a non-array top level — an empty list here would be indistinguishable from a genuinely empty roster of sessions", () => {
    expect(() => parseAgentsJson(JSON.stringify({ error: "not logged in" }))).toThrow();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseAgentsJson("not json")).toThrow();
  });
});

describe("listBackgroundAgents", () => {
  test("calls `claude agents --json` and parses the result", async () => {
    const calls: unknown[] = [];
    const result = await listBackgroundAgents(async (argv, opts) => {
      calls.push({ argv, opts });
      return { exitCode: 0, stdout: JSON.stringify([{ id: "x", cwd: "/c", kind: "background", startedAt: 5, sessionId: "s" }]), stderr: "" };
    });
    expect(calls).toEqual([{ argv: ["claude", "agents", "--json"], opts: { timeoutMs: 15_000 } }]);
    expect(result).toEqual([{ id: "x", sessionId: "s", cwd: "/c", startedAt: 5, pid: undefined }]);
  });

  test("throws on a non-zero exit rather than returning []", async () => {
    await expect(listBackgroundAgents(async () => ({ exitCode: 1, stdout: "", stderr: "not logged in" }))).rejects.toThrow(/not logged in/);
  });
});
