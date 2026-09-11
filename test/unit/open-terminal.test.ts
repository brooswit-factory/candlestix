import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAgent, createAgent, type AgentActionsDeps } from "../../src/agent-actions";
import { attachTargetDepsFrom } from "../../src/attach-target";
import { getOpenTerminalTarget } from "../../src/open-terminal";
import type { RunCommand } from "../../src/agents-cli";

interface Harness {
  deps: AgentActionsDeps;
  liveSessions: Array<{ id: string; sessionId: string; cwd: string }>;
}

async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-open-terminal-"));
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
    const deps: AgentActionsDeps = {
      agentSetPath,
      agentsBaseDir,
      agentDirectoryPath: (id) => join(agentsBaseDir, id),
      mcpConfigPath: (id) => join(dir, "runtime", "agents", id, "mcp.json"),
      runCommand,
      now: () => new Date((nowMs += 1)),
      random: () => ((randomSeed += 1) % 32) / 32,
    };

    return await fn({ deps, liveSessions });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("getOpenTerminalTarget — the seam for CNDLX-3", () => {
  test("unknown id-or-name gets the IDENTICAL refusal attach-target would give", async () => {
    await withHarness(async ({ deps }) => {
      const attachDeps = attachTargetDepsFrom(deps);
      const result = await getOpenTerminalTarget(attachDeps, "@nonexistent00000000");
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("not-found");
    });
  });

  test("off agent gets attach-target's identical 'off' refusal, never a not-implemented", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "sleepy", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const result = await getOpenTerminalTarget(attachTargetDepsFrom(deps), created.agent.id);
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("off");
    });
  });

  test("archived agent gets attach-target's identical 'archived' refusal", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "shelved", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const archived = await archiveAgent(deps, created.agent.id);
      expect(archived.ok).toBe(true);
      const result = await getOpenTerminalTarget(attachTargetDepsFrom(deps), created.agent.id);
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("archived");
    });
  });

  test("on agent with zero live sessions gets attach-target's identical 'no-live-session' refusal", async () => {
    await withHarness(async ({ deps, liveSessions }) => {
      const created = await createAgent(deps, { name: "willdie" });
      if (!created.ok) throw new Error("setup failed");
      liveSessions.length = 0;
      const result = await getOpenTerminalTarget(attachTargetDepsFrom(deps), created.agent.id);
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("no-live-session");
    });
  });

  test("on agent with exactly one live session: attach-target would SUCCEED, so this returns the honest not-implemented naming CNDLX-3", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "active" });
      if (!created.ok) throw new Error("setup failed");
      const result = await getOpenTerminalTarget(attachTargetDepsFrom(deps), created.agent.id);
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe("not-implemented");
      if (result.error.kind !== "not-implemented") return;
      expect(result.error.epic).toBe("CNDLX-3");
      expect(result.error.message).toContain("CNDLX-3");
      expect(result.error.message.toLowerCase()).toContain("not built yet");
    });
  });

  test("never returns ok:true — the type has no such branch and this asserts the runtime behaviour matches it", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "never-ok" });
      if (!created.ok) throw new Error("setup failed");
      const result = await getOpenTerminalTarget(attachTargetDepsFrom(deps), created.agent.id);
      expect(result.ok).toBe(false);
    });
  });
});
