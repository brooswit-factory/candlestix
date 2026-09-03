import { log } from "./log";
import { loadRoster } from "./roster-source";
import { runReconcileCycle } from "./supervisor";
import { runCommand } from "./exec";
import { createHeartbeatStore } from "./health/heartbeat";
import { startStalenessAlarm } from "./health/alarm";
import { startHealthSignalWriter } from "./health/signal";
import { rosterPath, registryPath, healthSignalPath, agentMcpConfigPath } from "./paths";

// This is candlestix's real cycle cadence, produced by this story (the
// ticket names this as a "first" — staleness.ts's DEFAULT_STALENESS_THRESHOLD_MS
// was a placeholder pending exactly this). RECONCILE_INTERVAL_MS is chosen,
// not measured: `claude agents --json` plus a handful of `stat`/`kill(pid,0)`
// calls per roster entry is cheap, so 20s is "responsive to a killed agent
// within tens of seconds" without polling aggressively for a product whose
// whole roster is expected to be a handful of very-long-lived agents, not
// hundreds.
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

async function main(): Promise<void> {
  log("info", "candlestix starting");

  const heartbeatStore = createHeartbeatStore();
  const resolvedRosterPath = rosterPath();
  const resolvedRegistryPath = registryPath();
  const resolvedHealthSignalPath = healthSignalPath();
  log("info", `roster path: ${resolvedRosterPath}`);
  log("info", `registry path: ${resolvedRegistryPath}`);
  log("info", `health signal path: ${resolvedHealthSignalPath}`);

  let cycleInFlight = false;

  const runCycle = async (): Promise<void> => {
    if (cycleInFlight) {
      log("warn", "previous reconcile cycle is still running; skipping this tick rather than overlapping it");
      return;
    }
    cycleInFlight = true;
    try {
      const rosterResult = await loadRoster(resolvedRosterPath);
      if (!rosterResult.ok) {
        log("error", `roster could not be loaded, no agents reconciled this cycle: ${rosterResult.errors.join("; ")}`);
        return;
      }
      await runReconcileCycle(rosterResult.roster, {
        registryPath: resolvedRegistryPath,
        agentMcpConfigPath,
        runCommand,
        heartbeatStore,
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
    // (see spawn.ts), not this service's cgroup. Their defined fate on
    // shutdown, restart, or crash of candlestix is: left running,
    // untouched, exactly where they are. That is what makes re-adoption on
    // the next startup possible at all — see supervisor.ts / reconcile.ts
    // and the README's "Restart survival" section for how the next
    // startup finds them again.
    clearInterval(reconcileTimer);
    alarm.stop();
    signal.stop();

    log("info", "supervisor loop and health timers stopped; any spawned agents are left running for the next startup to re-adopt");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
