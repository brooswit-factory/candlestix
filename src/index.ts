import { log } from "./log";
import { runReconcileCycle } from "./supervisor";
import { runCommand } from "./exec";
import { createHeartbeatStore } from "./health/heartbeat";
import { startStalenessAlarm } from "./health/alarm";
import { startHealthSignalWriter } from "./health/signal";
import { pathExists } from "./registry-store";
import {
  agentSetPath,
  agentsBaseDir,
  agentDirectoryPath,
  agentMcpConfigPath,
  registryPath,
  healthSignalPath,
  legacyRosterPath,
  apiSocketPath,
} from "./paths";
import { startApiServer, type ApiServerHandle } from "./api/server";
import type { AgentActionsDeps } from "./agent-actions";

// This is candlestix's real cycle cadence (staleness.ts's
// DEFAULT_STALENESS_THRESHOLD_MS was a placeholder pending exactly this).
// RECONCILE_INTERVAL_MS is chosen, not measured: `claude agents --json`
// plus a handful of `stat`/`kill(pid,0)` calls per agent is cheap, so 20s
// is "responsive to a killed agent within tens of seconds" without polling
// aggressively for a product whose whole agent set is expected to be a
// handful of very-long-lived agents, not hundreds.
const RECONCILE_INTERVAL_MS = 20_000;

// Deliberately NOT importing DEFAULT_STALENESS_THRESHOLD_MS (90s): that
// constant's own doc comment says it is a placeholder "three times an
// assumed ~30s cycle cadence...expected to be revisited once a real
// supervisor loop gives an actual cycle interval". This loop's real
// cadence is 20s, not 30s, so its threshold is computed from ITS OWN
// interval with the same reasoning (tolerate one slow cycle, not two)
// rather than inherited from the placeholder.
const STALENESS_THRESHOLD_MS = RECONCILE_INTERVAL_MS * 3;

const HEALTH_SIGNAL_INTERVAL_MS = RECONCILE_INTERVAL_MS;
const ALARM_INTERVAL_MS = RECONCILE_INTERVAL_MS;

/**
 * CNDLX-19 / R12: the roster is retired — no code path reads it any more
 * (see supervisor.ts, which now reads only the durable agent set). If a
 * legacy roster file still exists on disk, an operator may believe it is
 * still authoritative; silently ignoring it would hide that belief is now
 * wrong, and silently migrating it would create agents nobody asked for.
 * So: check ONCE, at startup — never once per cycle, which would be noise
 * — and if the file exists, say so loudly, naming its full path, that it
 * is no longer read, and what to do instead.
 */
async function warnIfLegacyRosterExists(): Promise<void> {
  const path = legacyRosterPath();
  if (await pathExists(path)) {
    log(
      "warn",
      `legacy roster file found at "${path}" — it is NO LONGER READ. Agents are now created and managed entirely through candlestix's own daemon-owned agent set (create/on/off/rename/archive/unarchive/delete — see agent-actions.ts), reachable over the daemon's own HTTP-over-Unix-socket API (see api/server.ts, CNDLX-32) and the \`candlestix\` CLI (CNDLX-28/CNDLX-31, a thin client of that same API). This file will never be consulted again; delete it or leave it in place, either is safe, but editing it will have no effect.`
    );
  }
}

async function main(): Promise<void> {
  log("info", "candlestix starting");

  await warnIfLegacyRosterExists();

  const heartbeatStore = createHeartbeatStore();
  const unexpectedSessionWarnings = new Map<string, string>();
  const resolvedAgentSetPath = agentSetPath();
  const resolvedAgentsBaseDir = agentsBaseDir();
  const resolvedRegistryPath = registryPath();
  const resolvedHealthSignalPath = healthSignalPath();
  const resolvedApiSocketPath = apiSocketPath();
  log("info", `agent set path: ${resolvedAgentSetPath}`);
  log("info", `agents directory: ${resolvedAgentsBaseDir}`);
  log("info", `registry path: ${resolvedRegistryPath}`);
  log("info", `health signal path: ${resolvedHealthSignalPath}`);
  log("info", `api socket path: ${resolvedApiSocketPath}`);

  const apiDeps: AgentActionsDeps = {
    agentSetPath: resolvedAgentSetPath,
    agentsBaseDir: resolvedAgentsBaseDir,
    agentDirectoryPath,
    mcpConfigPath: agentMcpConfigPath,
    runCommand,
    now: () => new Date(),
    random: () => Math.random(),
  };

  // Section 1's refusal-to-steal is fatal to daemon startup, not merely to
  // the API server component: a live socket at this path means another
  // candlestix daemon for this user is already running its own reconcile
  // loop against the same durable state, and starting a second one anyway
  // is exactly the "two writers" hazard section 5 exists to prevent — at
  // the process level rather than the in-process level this ticket's own
  // mutation queue covers.
  const apiServerResult = await startApiServer(apiDeps, resolvedApiSocketPath);
  if (!apiServerResult.ok) {
    log("error", apiServerResult.error.message);
    process.exit(1);
  }
  const apiServer: ApiServerHandle = apiServerResult.handle;
  log("info", `api server listening on unix socket "${apiServer.socketPath}"`);

  let cycleInFlight = false;

  const runCycle = async (): Promise<void> => {
    if (cycleInFlight) {
      log("warn", "previous reconcile cycle is still running; skipping this tick rather than overlapping it");
      return;
    }
    cycleInFlight = true;
    try {
      await runReconcileCycle({
        agentSetPath: resolvedAgentSetPath,
        agentDirectoryPath,
        agentMcpConfigPath,
        registryPath: resolvedRegistryPath,
        runCommand,
        heartbeatStore,
        unexpectedSessionWarnings,
      });
    } catch (err) {
      log("error", `reconcile cycle threw and was caught; the next scheduled tick still runs: ${String(err)}`);
    } finally {
      cycleInFlight = false;
    }
  };

  // Fire immediately (don't wait a full interval for the first cycle), then on schedule.
  void runCycle();
  const reconcileTimer = setInterval(() => void runCycle(), RECONCILE_INTERVAL_MS);

  const alarm = startStalenessAlarm({
    store: heartbeatStore,
    intervalMs: ALARM_INTERVAL_MS,
    thresholdMs: STALENESS_THRESHOLD_MS,
  });

  const signal = startHealthSignalWriter({
    store: heartbeatStore,
    path: resolvedHealthSignalPath,
    intervalMs: HEALTH_SIGNAL_INTERVAL_MS,
    thresholdMs: STALENESS_THRESHOLD_MS,
  });

  // setInterval keeps the event loop open; no separate keep-alive needed
  // now that the reconcile timer, the alarm, and the signal writer all run
  // on real timers of their own.

  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${sig}, shutting down`);

    // Stop OUR OWN timers only. Every blank agent candlestix has spawned
    // or adopted is a `claude --bg` background session — a process tree
    // that is a child of Claude Code's own persistent background-session
    // daemon, not of this process, and living in its own systemd scope
    // (see agent-spawn.ts), not this service's cgroup. Their defined fate
    // on shutdown, restart, or crash of candlestix is: left running,
    // untouched, exactly where they are — see the README's "Restart
    // survival" section for how the next startup finds them again.
    clearInterval(reconcileTimer);
    alarm.stop();
    signal.stop();
    apiServer.stop(); // section 1: remove the socket on clean shutdown.

    log("info", "supervisor loop, health timers, and the api server are stopped; any spawned agents are left running for the next startup to re-adopt");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
