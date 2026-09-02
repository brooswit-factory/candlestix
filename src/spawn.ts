import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RosterAgent } from "./roster";
import type { RunCommand } from "./agents-cli";

// Launches a fresh blank agent for a roster entry, using `claude --bg`
// (Claude Code's own background-session feature) rather than a hand-rolled
// pty. Why this instead of the ticket's own §6 Finding B (`setsid script`):
//
//   - `claude --bg` needs no controlling terminal at all — verified: it
//     runs to completion under stdio fully redirected to /dev/null, no pty
//     anywhere in its own invocation. Finding A's "no TTY -> falls back to
//     --print and exits" does not apply to `--bg`; it is a documented,
//     separate mode ("Start the session in the background and return
//     immediately"), not the bare interactive path Finding A tested.
//   - It also sidesteps the workspace-trust dialog: `claude --help` states
//     the trust dialog is skipped whenever stdout is not a TTY, which a
//     background session's stdout structurally never is. Verified live: a
//     `--bg` launch reports "idle — send a prompt to start" immediately,
//     never blocks on trust.
//   - It gives candlestix `claude agents --json` / `attach` / `logs` /
//     `stop` for free — exactly the "attachable in principle" surface this
//     ticket asks for, maintained by Claude Code itself rather than
//     candlestix's own pty/log-capture code.
//
// The cgroup hazard this ticket names (`KillMode=control-group` kills
// everything in a unit's cgroup) turned out to apply one level up, and was
// only found by testing: `claude --bg`'s very first invocation for a Unix
// user spawns a long-lived singleton (`claude daemon run`) that every
// future `--bg` session on the host shares, and it inherits whatever
// cgroup its FIRST invoker happened to be in — verified by watching its
// `/proc/<pid>/cgroup` after a bare `claude --bg` call. If candlestix ever
// happened to be that first invoker while running as its own systemd
// service, a later `systemctl --user restart candlestix` would SIGTERM
// that cgroup and take the shared singleton — and by extension every
// background agent on the host, not just candlestix's own — down with it.
// `systemd-run --user --scope` around every launch moves the invocation
// (and, if it is the first ever, the singleton it gives birth to) into its
// own independent, sibling cgroup before candlestix.service's own cgroup
// ever contains it — verified: a process launched this way keeps running,
// in its own cgroup, after the scope's own tracked process exits.
//
// `--expand-environment=no` is explicit rather than left to the default:
// systemd-run currently warns "not expanded by default for now, but will
// be expanded by default in the future" for a command line containing
// `$something` — an operator's job description is exactly the kind of
// free text that could contain a literal `$VAR`-looking sequence, and a
// future systemd defaulting to expanding it would silently corrupt that
// text. Pinning the flag makes today's behaviour permanent regardless of
// that future default change.

export interface SpawnDeps {
  runCommand: RunCommand;
  /** Injectable for tests. */
  writeMcpConfig?: (path: string, mcpServers: RosterAgent["mcpServers"]) => Promise<void>;
}

async function defaultWriteMcpConfig(path: string, mcpServers: RosterAgent["mcpServers"]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers }, null, 2) + "\n", "utf8");
}

export type SpawnResult = { ok: true } | { ok: false; error: string };

export async function spawnBackgroundAgent(agent: RosterAgent, mcpConfigPath: string, deps: SpawnDeps): Promise<SpawnResult> {
  const writeMcpConfig = deps.writeMcpConfig ?? defaultWriteMcpConfig;

  try {
    await writeMcpConfig(mcpConfigPath, agent.mcpServers);
  } catch (err) {
    return { ok: false, error: `writing MCP config failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const unitName = `candlestix-launch-${agent.name}-${randomUUID().slice(0, 8)}`;
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
    "--append-system-prompt",
    agent.job,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
  ];

  try {
    const result = await deps.runCommand(argv, { cwd: agent.cwd, timeoutMs: 20_000 });
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
