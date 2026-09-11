import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentActionsDeps } from "../../src/agent-actions";
import { attachTargetDepsFrom, decideAttachTarget, getAttachTarget, type AttachTargetDeps } from "../../src/attach-target";
import type { AgentRecord } from "../../src/agent";
import type { BackgroundAgentInfo } from "../../src/agents-cli";
import type { RunCommand } from "../../src/agents-cli";

function record(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { state: "off", createdAt: "2026-09-09T00:00:00.000Z", ...overrides };
}

function session(overrides: Partial<BackgroundAgentInfo> & { id: string; sessionId: string }): BackgroundAgentInfo {
  return { cwd: "/tmp/whatever", startedAt: 0, pid: 1234, ...overrides };
}

// ---------------------------------------------------------------------------
// Pure decision — unit-tested per branch (R9), zero and multiple sessions
// included, with no lookup to mock at all.
// ---------------------------------------------------------------------------

describe("decideAttachTarget — pure, R18/R9", () => {
  test("off is refused, never silently started", () => {
    const agent = record({ id: "@a", state: "off" });
    const result = decideAttachTarget(agent, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("off");
    expect(result.error.message).toContain("off");
    expect(result.error.message).toContain("on");
  });

  test("archived is refused, same reasoning as on-while-archived", () => {
    const agent = record({ id: "@a", state: "archived" });
    const result = decideAttachTarget(agent, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("archived");
    expect(result.error.message).toContain("archived");
  });

  test("on with ZERO live sessions is refused honestly — not a hang, not a spawn", () => {
    const agent = record({ id: "@a", state: "on" });
    const result = decideAttachTarget(agent, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("no-live-session");
    expect(result.error.message).toContain("no live session");
  });

  test("on with EXACTLY ONE live session succeeds, carrying id, name, short id, and full session id", () => {
    const agent = record({ id: "@a", name: "worker", state: "on" });
    const sess = session({ id: "shortid1", sessionId: "full-uuid-1" });
    const result = decideAttachTarget(agent, [sess]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toEqual({
      agentId: "@a",
      agentName: "worker",
      sessionShortId: "shortid1",
      sessionId: "full-uuid-1",
    });
  });

  test("on with an unnamed agent succeeds with agentName undefined", () => {
    const agent = record({ id: "@a", state: "on" });
    const sess = session({ id: "s1", sessionId: "full-1" });
    const result = decideAttachTarget(agent, [sess]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.agentName).toBeUndefined();
  });

  test("on with MORE THAN ONE live session is refused, listing every one — never picks the first match", () => {
    const agent = record({ id: "@a", state: "on" });
    const sessions = [session({ id: "s1", sessionId: "full-1" }), session({ id: "s2", sessionId: "full-2" }), session({ id: "s3", sessionId: "full-3" })];
    const result = decideAttachTarget(agent, sessions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("multiple-live-sessions");
    if (result.error.kind !== "multiple-live-sessions") return;
    expect(result.error.sessions).toEqual([
      { id: "s1", sessionId: "full-1" },
      { id: "s2", sessionId: "full-2" },
      { id: "s3", sessionId: "full-3" },
    ]);
    expect(result.error.message).toContain("s1");
    expect(result.error.message).toContain("s2");
    expect(result.error.message).toContain("s3");
  });
});

// ---------------------------------------------------------------------------
// The impure wrapper: load + resolve + look up live sessions + decide.
// ---------------------------------------------------------------------------

interface Harness {
  actionsDeps: AgentActionsDeps;
  attachDeps: AttachTargetDeps;
  liveSessions: Array<{ id: string; sessionId: string; cwd: string }>;
}

async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-attach-target-"));
  try {
    const agentSetPath = join(dir, "state", "agents.json");
    const agentsBaseDir = join(dir, "state", "agents");
    const liveSessions: Array<{ id: string; sessionId: string; cwd: string }> = [];
    let sessionCounter = 0;

    const runCommand: RunCommand = async (argv, opts) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        const cwdFlagIndex = argv.indexOf("--cwd");
        const cwd = cwdFlagIndex >= 0 ? argv[cwdFlagIndex + 1] : undefined;
        const matching = cwd !== undefined ? liveSessions.filter((s) => s.cwd === cwd) : liveSessions;
        return { exitCode: 0, stdout: JSON.stringify(matching.map((s) => ({ kind: "background", startedAt: 0, ...s }))), stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        const newId = `sess${sessionCounter++}`;
        liveSessions.push({ id: newId, sessionId: `${newId}-full`, cwd: opts.cwd ?? "" });
        return { exitCode: 0, stdout: `backgrounded · ${newId} (idle)`, stderr: "" };
      }
      throw new Error(`unmocked command: ${argv.join(" ")}`);
    };

    let nowMs = 1_726_000_000_000;
    let randomSeed = 0;
    const actionsDeps: AgentActionsDeps = {
      agentSetPath,
      agentsBaseDir,
      agentDirectoryPath: (id) => join(agentsBaseDir, id),
      mcpConfigPath: (id) => join(dir, "runtime", "agents", id, "mcp.json"),
      runCommand,
      now: () => new Date((nowMs += 1)),
      random: () => ((randomSeed += 1) % 32) / 32,
    };

    return await fn({ actionsDeps, attachDeps: attachTargetDepsFrom(actionsDeps), liveSessions });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("getAttachTarget — the impure wrapper", () => {
  test("unknown id-or-name gets the typed not-found", async () => {
    await withHarness(async ({ attachDeps }) => {
      const result = await getAttachTarget(attachDeps, "@nonexistent00000000");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("not-found");
    });
  });

  test("off agent is refused via the real store + resolver path", async () => {
    await withHarness(async ({ actionsDeps, attachDeps }) => {
      const created = await createAgent(actionsDeps, { name: "sleepy", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const result = await getAttachTarget(attachDeps, created.agent.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("off");
    });
  });

  test("archived agent is refused via the real store + resolver path", async () => {
    await withHarness(async ({ actionsDeps, attachDeps }) => {
      const created = await createAgent(actionsDeps, { name: "shelved", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const { archiveAgent } = await import("../../src/agent-actions");
      const archived = await archiveAgent(actionsDeps, created.agent.id);
      expect(archived.ok).toBe(true);
      const result = await getAttachTarget(attachDeps, created.agent.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("archived");
    });
  });

  test("on agent with exactly one real spawned session succeeds", async () => {
    await withHarness(async ({ actionsDeps, attachDeps }) => {
      const created = await createAgent(actionsDeps, { name: "active" }); // initialState defaults to "on" and spawns via the fake systemd-run
      if (!created.ok) throw new Error("setup failed");
      const result = await getAttachTarget(attachDeps, created.agent.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.target.agentId).toBe(created.agent.id);
      expect(result.target.agentName).toBe("active");
      expect(result.target.sessionShortId).toBeTruthy();
      expect(result.target.sessionId).toBeTruthy();
    });
  });

  test("on agent resolvable by name, not just id", async () => {
    await withHarness(async ({ actionsDeps, attachDeps }) => {
      const created = await createAgent(actionsDeps, { name: "byname" });
      if (!created.ok) throw new Error("setup failed");
      const result = await getAttachTarget(attachDeps, "byname");
      expect(result.ok).toBe(true);
    });
  });

  test("on agent with zero live sessions (just created but not yet reflected) is refused honestly", async () => {
    await withHarness(async ({ actionsDeps, attachDeps, liveSessions }) => {
      const created = await createAgent(actionsDeps, { name: "willdie" });
      if (!created.ok) throw new Error("setup failed");
      // Simulate the session having died since creation, with the record still "on".
      liveSessions.length = 0;
      const result = await getAttachTarget(attachDeps, created.agent.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("no-live-session");
    });
  });

  test("store-malformed refuses before ever resolving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-attach-target-malformed-"));
    try {
      const agentSetPath = join(dir, "agents.json");
      await Bun.write(agentSetPath, "{ not json");
      const deps: AttachTargetDeps = {
        agentSetPath,
        agentDirectoryPath: (id) => join(dir, "agents", id),
        runCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
      };
      const result = await getAttachTarget(deps, "@whatever0000000000");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("store-malformed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
