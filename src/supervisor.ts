import type { Roster, RosterAgent } from "./roster";
import type { HeartbeatStore } from "./health/heartbeat";
import { listBackgroundAgents, type BackgroundAgentInfo, type RunCommand } from "./agents-cli";
import { decideReconcileAction } from "./reconcile";
import { spawnBackgroundAgent } from "./spawn";
import { isPidAlive } from "./proc";
import { loadRegistry, saveRegistry, pathExists } from "./registry-store";
import { upsertRegistryEntry, type Registry } from "./registry";
import { log } from "./log";

export interface SupervisorOptions {
  registryPath: string;
  agentMcpConfigPath: (agentName: string) => string;
  runCommand: RunCommand;
  heartbeatStore: Pick<HeartbeatStore, "registerSubject" | "recordHeartbeat">;
  now?: () => Date;
}

async function reconcileOneAgent(
  agent: RosterAgent,
  registry: Registry,
  backgroundAgents: BackgroundAgentInfo[] | undefined,
  listError: unknown,
  options: SupervisorOptions
): Promise<Registry> {
  options.heartbeatStore.registerSubject(agent.name);

  if (backgroundAgents === undefined) {
    log(
      "error",
      `cannot reconcile "${agent.name}" this cycle: listing claude's background agents failed, so no heartbeat is recorded: ${
        listError instanceof Error ? listError.message : String(listError)
      }`
    );
    return registry;
  }

  const verifiedAlivePids = new Set(
    backgroundAgents.filter((a): a is BackgroundAgentInfo & { pid: number } => a.pid !== undefined && isPidAlive(a.pid)).map((a) => a.pid)
  );

  const cwdExists = await pathExists(agent.cwd);

  const action = decideReconcileAction({
    agentName: agent.name,
    agentCwd: agent.cwd,
    registryEntry: registry.agents[agent.name],
    backgroundAgents,
    verifiedAlivePids,
    cwdExists,
  });

  switch (action.type) {
    case "heartbeat": {
      options.heartbeatStore.recordHeartbeat(agent.name, options.now?.() ?? new Date());
      return upsertRegistryEntry(registry, action.entry);
    }
    case "wait":
      log("warn", `"${agent.name}": ${action.reason}; not recording a heartbeat this cycle`);
      return registry;
    case "cwd-missing":
      log(
        "error",
        `"${agent.name}": cwd "${agent.cwd}" does not exist — this entry is skipped, the loop and every other agent are unaffected`
      );
      return registry;
    case "spawn": {
      const result = await spawnBackgroundAgent(agent, options.agentMcpConfigPath(agent.name), { runCommand: options.runCommand });
      if (!result.ok) {
        log("error", `"${agent.name}": spawn failed, no heartbeat recorded: ${result.error}`);
      } else {
        // Deliberately no heartbeat here. A zero exit from the launcher is
        // evidence the launch command ran, not evidence the agent is
        // alive — the heartbeat contract requires the cycle to have
        // GENUINELY completed. The next cycle's fresh `claude agents
        // --json` + independent pid check is what actually proves it, and
        // is what records the heartbeat, via the "heartbeat" branch above.
        log("info", `"${agent.name}": spawn launched; will confirm and record a heartbeat once it is independently verified alive`);
      }
      return registry;
    }
  }
}

export async function runReconcileCycle(roster: Roster, options: SupervisorOptions): Promise<void> {
  let registry = await loadRegistry(options.registryPath);

  let backgroundAgents: BackgroundAgentInfo[] | undefined;
  let listError: unknown;
  try {
    backgroundAgents = await listBackgroundAgents(options.runCommand);
  } catch (err) {
    listError = err;
  }

  // Sequential, not concurrent: this keeps "one bad entry does not affect
  // others" obviously true by construction (no shared-registry mutation
  // across interleaved awaits to reason about), which matters more here
  // than the latency of a few `systemd-run` calls at the roster sizes this
  // product targets — a handful of very-long-lived specialty agents, not
  // hundreds. The try/catch is a second line of defence in case a future
  // change makes some step throw: reconcileOneAgent is not expected to
  // throw today (every fallible step inside it already catches its own
  // errors), but one entry throwing must cost that entry's turn, never the
  // whole cycle — the same reasoning alarm.ts's tick already documents.
  for (const agent of roster.agents) {
    try {
      registry = await reconcileOneAgent(agent, registry, backgroundAgents, listError, options);
    } catch (err) {
      log("error", `"${agent.name}": reconcile threw and was caught, no heartbeat recorded, other agents unaffected: ${String(err)}`);
    }
  }

  await saveRegistry(options.registryPath, registry);
}
