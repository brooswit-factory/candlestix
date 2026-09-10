import { describe, expect, test } from "bun:test";
import {
  findAgentSessions,
  removeSession,
  stopAllSessionsUnderCwd,
  stopAndRemoveAllSessionsUnderCwd,
  stopSession,
} from "../../src/agent-session";
import type { RunCommand } from "../../src/agents-cli";

function fakeAgentsJson(sessions: Array<{ id: string; sessionId: string; cwd: string; startedAt?: number; pid?: number }>): string {
  return JSON.stringify(sessions.map((s) => ({ kind: "background", startedAt: s.startedAt ?? 0, pid: s.pid, ...s })));
}

describe("findAgentSessions — S2: by directory, exact match, never a name-keyed registry", () => {
  test("passes --cwd as a pre-filter, and calls", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: fakeAgentsJson([{ id: "abc", sessionId: "abc-full", cwd: "/agents/@x" }]), stderr: "" };
    };
    await findAgentSessions(runCommand, "/agents/@x");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["claude", "agents", "--json", "--cwd", "/agents/@x"]);
  });

  test("re-filters to an EXACT cwd match — --cwd is documented as a PREFIX ('under'), never trusted alone", async () => {
    const runCommand: RunCommand = async () => ({
      exitCode: 0,
      stdout: fakeAgentsJson([
        { id: "exact", sessionId: "exact-full", cwd: "/state/agents/@abc" },
        { id: "prefix-only", sessionId: "prefix-full", cwd: "/state/agents/@abc-something-else" },
      ]),
      stderr: "",
    });
    const sessions = await findAgentSessions(runCommand, "/state/agents/@abc");
    expect(sessions.map((s) => s.id)).toEqual(["exact"]);
  });

  test("zero matches is a genuine, successful empty result", async () => {
    const runCommand: RunCommand = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    expect(await findAgentSessions(runCommand, "/agents/@x")).toEqual([]);
  });

  test("a failed listing throws — 'could not look' must never read as 'nothing there'", async () => {
    const runCommand: RunCommand = async () => ({ exitCode: 1, stdout: "", stderr: "not logged in" });
    await expect(findAgentSessions(runCommand, "/agents/@x")).rejects.toThrow(/not logged in/);
  });
});

describe("stopSession / removeSession — R7: the per-session verb, never a cgroup/scope/systemctl", () => {
  test("stopSession calls exactly `claude stop <id>`", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await stopSession(runCommand, "abc12345");
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["claude", "stop", "abc12345"]]);
  });

  test("stopSession surfaces a non-zero exit as ok:false with real stderr", async () => {
    const runCommand: RunCommand = async () => ({ exitCode: 1, stdout: "", stderr: "no such session" });
    const result = await stopSession(runCommand, "abc12345");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("no such session") });
  });

  test("removeSession calls exactly `claude rm <id>`", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await removeSession(runCommand, "abc12345");
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["claude", "rm", "abc12345"]]);
  });

  test("neither stopSession nor removeSession ever invokes systemd-run, systemctl, or a bare kill", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await stopSession(runCommand, "x");
    await removeSession(runCommand, "x");
    for (const argv of calls) {
      expect(argv[0]).toBe("claude");
      expect(argv.join(" ")).not.toContain("systemctl");
      expect(argv.join(" ")).not.toContain("systemd-run");
    }
  });
});

describe("stopAllSessionsUnderCwd — S2's ambiguity ruling: stop EVERY match, not just the first", () => {
  test("no matching session is a success with an empty stopped list", async () => {
    const runCommand: RunCommand = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    expect(await stopAllSessionsUnderCwd(runCommand, "/agents/@x")).toEqual({ stopped: [], failed: [] });
  });

  test("exactly one match is stopped", async () => {
    const stoppedIds: string[] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[1] === "agents") {
        return { exitCode: 0, stdout: fakeAgentsJson([{ id: "abc", sessionId: "abc-full", cwd: "/agents/@x" }]), stderr: "" };
      }
      if (argv[1] === "stop") {
        stoppedIds.push(argv[2] as string);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    };
    const result = await stopAllSessionsUnderCwd(runCommand, "/agents/@x");
    expect(result).toEqual({ stopped: ["abc"], failed: [] });
    expect(stoppedIds).toEqual(["abc"]);
  });

  test("two sessions matching the same exact cwd are BOTH stopped — the real ambiguity is handled explicitly, not by taking the first", async () => {
    const stoppedIds: string[] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[1] === "agents") {
        return {
          exitCode: 0,
          stdout: fakeAgentsJson([
            { id: "first", sessionId: "first-full", cwd: "/agents/@x" },
            { id: "second", sessionId: "second-full", cwd: "/agents/@x" },
          ]),
          stderr: "",
        };
      }
      if (argv[1] === "stop") {
        stoppedIds.push(argv[2] as string);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    };
    const result = await stopAllSessionsUnderCwd(runCommand, "/agents/@x");
    expect(result.stopped.sort()).toEqual(["first", "second"]);
    expect(stoppedIds.sort()).toEqual(["first", "second"]);
  });

  test("a session that fails to stop is reported in `failed`, and other matches are still attempted", async () => {
    const runCommand: RunCommand = async (argv) => {
      if (argv[1] === "agents") {
        return {
          exitCode: 0,
          stdout: fakeAgentsJson([
            { id: "bad", sessionId: "bad-full", cwd: "/agents/@x" },
            { id: "good", sessionId: "good-full", cwd: "/agents/@x" },
          ]),
          stderr: "",
        };
      }
      if (argv[1] === "stop") {
        if (argv[2] === "bad") return { exitCode: 1, stdout: "", stderr: "boom" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    };
    const result = await stopAllSessionsUnderCwd(runCommand, "/agents/@x");
    expect(result.stopped).toEqual(["good"]);
    expect(result.failed).toEqual([{ id: "bad", error: expect.stringContaining("boom") }]);
  });
});

describe("stopAndRemoveAllSessionsUnderCwd — S3's ordering: stop, THEN rm, per session", () => {
  test("calls stop before rm, for each matching session", async () => {
    const order: string[] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[1] === "agents") {
        return { exitCode: 0, stdout: fakeAgentsJson([{ id: "abc", sessionId: "abc-full", cwd: "/agents/@x" }]), stderr: "" };
      }
      order.push(`${argv[1]}:${argv[2]}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await stopAndRemoveAllSessionsUnderCwd(runCommand, "/agents/@x");
    expect(result).toEqual({ removed: ["abc"], failed: [] });
    expect(order).toEqual(["stop:abc", "rm:abc"]);
  });

  test("if stop fails, rm is never attempted for that session — never remove a conversation that might still be live", async () => {
    const rmCalled: string[] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[1] === "agents") {
        return { exitCode: 0, stdout: fakeAgentsJson([{ id: "abc", sessionId: "abc-full", cwd: "/agents/@x" }]), stderr: "" };
      }
      if (argv[1] === "stop") return { exitCode: 1, stdout: "", stderr: "cannot stop" };
      if (argv[1] === "rm") {
        rmCalled.push(argv[2] as string);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error("unreachable");
    };
    const result = await stopAndRemoveAllSessionsUnderCwd(runCommand, "/agents/@x");
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ id: "abc", error: expect.stringContaining("cannot stop") }]);
    expect(rmCalled).toEqual([]);
  });

  test("no matching session is a success with empty removed/failed", async () => {
    const runCommand: RunCommand = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    expect(await stopAndRemoveAllSessionsUnderCwd(runCommand, "/agents/@x")).toEqual({ removed: [], failed: [] });
  });
});
