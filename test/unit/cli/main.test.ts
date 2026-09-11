import { describe, expect, test } from "bun:test";
import { createApiClient } from "../../../src/cli/api-client";
import { EXIT_DAEMON_UNREACHABLE, EXIT_REFUSAL, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "../../../src/cli/exit-codes";
import { runCli, type CliIO } from "../../../src/cli/main";
import { absentSocketPath, startFakeServer, type RecordedRequest, type ScriptedResponse } from "./fake-server";

interface TestIO extends CliIO {
  stdoutLog: string[];
  stderrLog: string[];
}

function fakeIo(overrides: Partial<CliIO> = {}): TestIO {
  const stdoutLog: string[] = [];
  const stderrLog: string[] = [];
  return {
    writeStdout: (s) => stdoutLog.push(s),
    writeStderr: (s) => stderrLog.push(s),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    promptAndReadLine: async () => "",
    spawnAttach: async () => 0,
    stdoutLog,
    stderrLog,
    ...overrides,
  };
}

async function withServer<T>(handler: (req: RecordedRequest) => ScriptedResponse, fn: (socketPath: string) => Promise<T>): Promise<T> {
  const server = await startFakeServer(handler);
  try {
    return await fn(server.socketPath);
  } finally {
    await server.close();
  }
}

describe("runCli — create", () => {
  test("prints the new id, name and the exact attach command; exits 0", async () => {
    await withServer(
      () => ({ body: { ok: true, agent: { id: "@abc123", name: "foo", state: "on", createdAt: "x" } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["--name", "foo"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("")).toContain("@abc123");
        expect(io.stdoutLog.join("")).toContain('"foo"');
        expect(io.stdoutLog.join("")).toContain("candlestix @abc123");
      }
    );
  });

  test("a create refusal (e.g. reserved name) prints the daemon's message verbatim and exits 1", async () => {
    await withServer(
      () => ({ status: 409, body: { ok: false, error: { kind: "reserved-name", message: '"list" is reserved and cannot be used as an agent name' } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["--name", "list"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toBe('"list" is reserved and cannot be used as an agent name\n');
      }
    );
  });
});

describe("runCli — list", () => {
  const agents = [
    { id: "@a", name: "on-one", state: "on", createdAt: "x" },
    { id: "@b", name: "off-one", state: "off", createdAt: "x" },
    { id: "@c", name: "archived-one", state: "archived", createdAt: "x" },
  ];

  test("hides archived by default", async () => {
    await withServer(
      () => ({ body: { ok: true, agents } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["list"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        const out = io.stdoutLog.join("");
        expect(out).toContain("@a");
        expect(out).toContain("@b");
        expect(out).not.toContain("@c");
      }
    );
  });

  test("--archived shows archived too, clearly distinguishable by its state", async () => {
    await withServer(
      () => ({ body: { ok: true, agents } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["list", "--archived"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        const out = io.stdoutLog.join("");
        expect(out).toContain("@a");
        expect(out).toContain("@b");
        expect(out).toContain("@c");
        expect(out).toContain("archived"); // the state label itself distinguishes it
      }
    );
  });

  test("an empty set prints a clear message, not a blank line, and exits 0", async () => {
    await withServer(
      () => ({ body: { ok: true, agents: [] } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["list"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("").trim().length).toBeGreaterThan(0);
      }
    );
  });
});

describe("runCli — on/off/archive/unarchive, R6's no-change diagonal rendered distinctly", () => {
  test("off -> off (no-change) renders 'already off', not 'turned off', and exits 0", async () => {
    await withServer(
      () => ({ body: { ok: true, outcome: { kind: "no-change" } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["my-agent", "off"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("")).toContain("already off");
        expect(io.stdoutLog.join("")).not.toContain("turned off");
      }
    );
  });

  test("on -> off (a real change) renders 'turned off', not 'already off'", async () => {
    await withServer(
      () => ({ body: { ok: true, outcome: { kind: "turned-off" } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["my-agent", "off"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("")).toContain("turned off");
        expect(io.stdoutLog.join("")).not.toContain("already");
      }
    );
  });

  test("turning an archived agent on is refused, message printed verbatim, exit 1", async () => {
    await withServer(
      () => ({ status: 409, body: { ok: false, error: { kind: "already-archived", message: "agent is archived; turning an archived agent on is refused" } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["my-agent", "on"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toBe("agent is archived; turning an archived agent on is refused\n");
      }
    );
  });
});

describe("runCli — rename", () => {
  test("success prints the id and the new name", async () => {
    await withServer(
      () => ({ body: { ok: true, agent: { id: "@abc", name: "new-name", state: "on", createdAt: "x" } } }),
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["my-agent", "name", "new-name"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("")).toContain("@abc");
        expect(io.stdoutLog.join("")).toContain("new-name");
      }
    );
  });
});

describe("runCli — delete, the full confirmation matrix end to end", () => {
  test("TTY affirmative: prompts, then calls the daemon, and reports deleted", async () => {
    const requests: RecordedRequest[] = [];
    await withServer(
      (req) => {
        requests.push(req);
        if (req.path.endsWith("/delete")) return { body: { ok: true, outcome: { kind: "deleted" } } };
        return { body: { ok: true, agents: [{ id: "@abc", name: "doomed", state: "off", createdAt: "x" }] } };
      },
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: true, promptAndReadLine: async () => "yes" });
        const exitCode = await runCli(["doomed", "delete"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(io.stdoutLog.join("")).toContain("Deleted");
        expect(requests.some((r) => r.path.endsWith("/delete"))).toBe(true);
      }
    );
  });

  test("TTY declined: never calls delete on the daemon, exits 1", async () => {
    const requests: RecordedRequest[] = [];
    await withServer(
      (req) => {
        requests.push(req);
        if (req.path.endsWith("/delete")) return { body: { ok: true, outcome: { kind: "deleted" } } };
        return { body: { ok: true, agents: [] } };
      },
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: true, promptAndReadLine: async () => "no" });
        const exitCode = await runCli(["doomed", "delete"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(requests.some((r) => r.path.endsWith("/delete"))).toBe(false);
      }
    );
  });

  test("--yes: never prompts, calls delete directly", async () => {
    let prompted = false;
    const requests: RecordedRequest[] = [];
    await withServer(
      (req) => {
        requests.push(req);
        return { body: { ok: true, outcome: { kind: "deleted" } } };
      },
      async (socketPath) => {
        const io = fakeIo({
          stdinIsTTY: true,
          promptAndReadLine: async () => {
            prompted = true;
            return "yes";
          },
        });
        const exitCode = await runCli(["doomed", "delete", "--yes"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(prompted).toBe(false);
        expect(requests.some((r) => r.path.endsWith("/delete"))).toBe(true);
      }
    );
  });

  test("non-TTY without --yes: refused, exit 1, message says to pass --yes, daemon never contacted for the delete", async () => {
    const requests: RecordedRequest[] = [];
    await withServer(
      (req) => {
        requests.push(req);
        return { body: { ok: true, outcome: { kind: "deleted" } } };
      },
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: false });
        const exitCode = await runCli(["doomed", "delete"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toContain("--yes");
        expect(requests.some((r) => r.path.endsWith("/delete"))).toBe(false);
      }
    );
  });

  test("non-TTY WITH --yes: proceeds without any prompt", async () => {
    const requests: RecordedRequest[] = [];
    await withServer(
      (req) => {
        requests.push(req);
        return { body: { ok: true, outcome: { kind: "deleted" } } };
      },
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: false });
        const exitCode = await runCli(["doomed", "delete", "--yes"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_SUCCESS);
        expect(requests.some((r) => r.path.endsWith("/delete"))).toBe(true);
      }
    );
  });
});

describe("runCli — attach", () => {
  test("attach-target refusal (e.g. off) is printed verbatim, exit 1, and spawnAttach is NEVER called (R18: never silently starts an off agent)", async () => {
    let spawned = false;
    await withServer(
      () => ({ status: 409, body: { ok: false, error: { kind: "off", message: "agent is off; turn it on first" } } }),
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: true, stdoutIsTTY: true, spawnAttach: async () => { spawned = true; return 0; } });
        const exitCode = await runCli(["my-agent"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toBe("agent is off; turn it on first\n");
        expect(spawned).toBe(false);
      }
    );
  });

  test("success: spawns claude attach with the session's short id, and PROPAGATES its exit code exactly, even when it collides with candlestix's own codes", async () => {
    await withServer(
      () => ({ body: { ok: true, agentId: "@abc", sessionShortId: "sess42", sessionId: "sess42-full" } }),
      async (socketPath) => {
        let receivedId: string | undefined;
        const io = fakeIo({
          stdinIsTTY: true,
          stdoutIsTTY: true,
          spawnAttach: async (id) => {
            receivedId = id;
            return 3; // deliberately chosen to collide with EXIT_DAEMON_UNREACHABLE, to prove no translation happens
          },
        });
        const exitCode = await runCli(["my-agent"], { apiClient: createApiClient({ socketPath }), io });
        expect(receivedId).toBe("sess42");
        expect(exitCode).toBe(3);
      }
    );
  });

  test("non-TTY: refused before ever spawning, distinct message, exit 1", async () => {
    let spawned = false;
    await withServer(
      () => ({ body: { ok: true, agentId: "@abc", sessionShortId: "sess1", sessionId: "sess1-full" } }),
      async (socketPath) => {
        const io = fakeIo({ stdinIsTTY: false, stdoutIsTTY: false, spawnAttach: async () => { spawned = true; return 0; } });
        const exitCode = await runCli(["my-agent"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toContain("TTY");
        expect(spawned).toBe(false);
      }
    );
  });
});

describe("runCli — usage errors never touch the network", () => {
  test("an unknown verb is a usage error with exit code 2, and the daemon (pointed at an absent socket) is never contacted", async () => {
    const { socketPath, cleanup } = await absentSocketPath();
    try {
      const io = fakeIo();
      const exitCode = await runCli(["my-agent", "frobnicate"], { apiClient: createApiClient({ socketPath }), io });
      expect(exitCode).toBe(EXIT_USAGE_ERROR);
      expect(io.stderrLog.join("")).toContain("frobnicate");
    } finally {
      await cleanup();
    }
  });
});

describe("runCli — daemon unreachable", () => {
  test("exits with the daemon-unreachable code and names the socket path tried", async () => {
    const { socketPath, cleanup } = await absentSocketPath();
    try {
      const io = fakeIo();
      const exitCode = await runCli(["list"], { apiClient: createApiClient({ socketPath }), io });
      expect(exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
      expect(io.stderrLog.join("")).toContain(socketPath);
    } finally {
      await cleanup();
    }
  });
});

describe("runCli — the message-less-refusal fallback, exercised end to end through a real command", () => {
  test("a refusal with no message renders the generic fallback line and still exits with the refusal code", async () => {
    await withServer(
      () => ({ status: 500, body: { ok: false, error: { kind: "store-malformed" } } }), // no "message" field at all
      async (socketPath) => {
        const io = fakeIo();
        const exitCode = await runCli(["list"], { apiClient: createApiClient({ socketPath }), io });
        expect(exitCode).toBe(EXIT_REFUSAL);
        expect(io.stderrLog.join("")).toContain("store-malformed");
        expect(io.stderrLog.join("")).toContain("sent no message");
      }
    );
  });
});
