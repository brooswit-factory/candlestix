// The spawn entry point for a DAEMON-CREATED agent (an `AgentRecord`), as
// distinct from spawn.ts's `spawnBackgroundAgent` (a roster entry: required
// `job`, required `cwd`, name-keyed MCP path). That existing function and
// its roster shape are left untouched — CNDLX-19 retires both along with
// the roster itself; this is a sibling, not a replacement.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentRecord } from "./agent";
import type { RunCommand } from "./agents-cli";

export interface AgentSpawnDeps {
  runCommand: RunCommand;
  /** Injectable for tests. Defaults to writing a real `{"mcpServers":{}}` file (S6). */
  writeMcpConfig?: (path: string) => Promise<void>;
}

async function defaultWriteEmptyMcpConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // S6: an empty MCP config, not "no config at all" — `--strict-mcp-config`
  // is kept below, so this is what makes a daemon-created agent get exactly
  // zero MCP servers rather than silently inheriting the operator's whole
  // ambient config. How an operator ADDS an MCP server to an agent later is
  // unowned by any current story — see this ticket's doc.
  await writeFile(path, JSON.stringify({ mcpServers: {} }, null, 2) + "\n", "utf8");
}

export type SpawnDaemonAgentResult = { ok: true } | { ok: false; error: string };

/**
 * R11: `job` is OPTIONAL on an `AgentRecord`. Where absent, the
 * `--append-system-prompt` flag is OMITTED from argv entirely — never
 * passed an empty string. This is the live fix R11 asks for on THIS spawn
 * path; spawn.ts's roster-driven `spawnBackgroundAgent` is left passing it
 * unconditionally, which is correct there (a roster entry's `job` is
 * required, not optional) and is retired with the roster by CNDLX-19, not
 * fixed here.
 *
 * S6: writes an empty MCP config at the ID-KEYED path the caller supplies
 * (see `paths.ts`'s `agentMcpConfigPath`, R16) and keeps
 * `--strict-mcp-config` — the property that flag exists for (an agent gets
 * exactly the MCP servers candlestix configured, nothing ambient) is
 * preserved even though this ticket configures none.
 *
 * Everything else mirrors spawn.ts's own reasoning verbatim: `claude --bg`
 * needs no TTY and skips the trust dialog; every launch is wrapped in its
 * own `systemd-run --user --scope` to keep this invocation (and, if it is
 * the very first `claude --bg` on this Unix user, the shared `claude
 * daemon run` singleton it gives birth to) out of candlestix.service's own
 * cgroup (R7); `--expand-environment=no` is pinned so a future systemd
 * default change cannot start expanding `$`-looking text in a job
 * description.
 */
export async function spawnDaemonAgent(
  agent: Pick<AgentRecord, "id" | "job">,
  cwd: string,
  mcpConfigPath: string,
  deps: AgentSpawnDeps
): Promise<SpawnDaemonAgentResult> {
  const writeMcpConfig = deps.writeMcpConfig ?? defaultWriteEmptyMcpConfig;

  try {
    await writeMcpConfig(mcpConfigPath);
  } catch (err) {
    return { ok: false, error: `writing MCP config failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Strip the leading "@" for the systemd unit name: unit-name escaping
  // rules for "@" are instance-unit syntax we have no reason to court, and
  // the id's body (18 Crockford base32 chars) is already unit-name-safe on
  // its own.
  const unitName = `candlestix-launch-${agent.id.slice(1)}-${randomUUID().slice(0, 8)}`;
  const argv = [
    "systemd-run",
    "--user",
    "--scope",
    `--unit=${unitName}`,
    "--collect",
    "--expand-environment=no",
    "--",
    "claude",
    "--bg",
    ...(agent.job !== undefined ? ["--append-system-prompt", agent.job] : []),
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
  ];

  try {
    const result = await deps.runCommand(argv, { cwd, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `launch exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `launch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
