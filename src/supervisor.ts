import type { AgentRecord } from "./agent";
import { loadAgentSet } from "./agent-set-store";
import type { HeartbeatStore } from "./health/heartbeat";
import { listBackgroundAgents, type BackgroundAgentInfo, type RunCommand } from "./agents-cli";
import { decideReconcileAction } from "./reconcile";
import { spawnDaemonAgent } from "./agent-spawn";
import { isPidAlive } from "./proc";
import { loadRegistry, saveRegistry, pathExists } from "./registry-store";
import { upsertRegistryEntry, type Registry } from "./registry";
import { log } from "./log";

// CNDLX-19: the reconcile loop reads CNDLX-17's durable agent set, not a
// roster (retired — see README's "Legacy roster file"), and applies R14
// / R7's spawn path (agent-spawn.ts, CNDLX-18) instead of the old
// roster-driven one (spawn.ts, deleted with the roster).

export interface SupervisorOptions {
  agentSetPath: string;
  agentDirectoryPath: (agentId: string) => string;
  agentMcpConfigPath: (agentId: string) => string;
  registryPath: string;
  runCommand: RunCommand;
  heartbeatStore: Pick<HeartbeatStore, "registerSubject" | "recordHeartbeat" | "unregisterSubject" | "listTrackedSubjects">;
  /**
   * T2's noise-suppression state for the "off/archived but a live session
   * exists anyway" report: agentId -> the signature (sorted session ids,
   * joined) last warned about for that agent. Created ONCE by the caller
   * (src/index.ts) and threaded through every cycle — this must NOT be
   * reset per cycle, or the warning would repeat every 20 seconds, exactly
   * the noise T2/R12 forbid ("do not re-emit an identical message for an
   * unchanged condition on every cycle").
   */
  unexpectedSessionWarnings: Map<string, string>;
  now?: () => Date;
}

function agentLabel(agent: Pick<AgentRecord, "id" | "name">): string {
  return agent.name !== undefined ? `"${agent.name}" (${agent.id})` : agent.id;
}

async function reconcileOneAgent(
  agent: AgentRecord,
  registry: Registry,
  backgroundAgents: BackgroundAgentInfo[] | undefined,
  listError: unknown,
  options: SupervisorOptions
): Promise<Registry> {
  const label = agentLabel(agent);

  if (backgroundAgents === undefined) {
    log(
      "error",
      `cannot reconcile ${label} this cycle: listing claude's background agents failed, so no heartbeat is recorded: ${
        listError instanceof Error ? listError.message : String(listError)
      }`
    );
    return registry;
  }

  const verifiedAlivePids = new Set(
    backgroundAgents.filter((a): a is BackgroundAgentInfo & { pid: number } => a.pid !== undefined && isPidAlive(a.pid)).map((a) => a.pid)
  );

  const agentDir = options.agentDirectoryPath(agent.id);
  const dirExists = await pathExists(agentDir);

  const action = decideReconcileAction({
    agentId: agent.id,
    agentName: agent.name,
    state: agent.state,
    agentDir,
    registryEntry: registry.agents[agent.id],
    backgroundAgents,
    verifiedAlivePids,
    dirExists,
  });

  switch (action.type) {
    case "heartbeat": {
      options.heartbeatStore.recordHeartbeat(agent.id, options.now?.() ?? new Date(), agent.name);
      options.unexpectedSessionWarnings.delete(agent.id);
      return upsertRegistryEntry(registry, action.entry);
    }
    case "wait":
      log("warn", `${label}: ${action.reason}; not recording a heartbeat this cycle`);
      return registry;
    case "dir-missing":
      log(
        "error",
        `${label}: directory "${agentDir}" does not exist — this agent is skipped, the loop and every other agent are unaffected`
      );
      return registry;
    case "spawn": {
      const result = await spawnDaemonAgent(agent, agentDir, options.agentMcpConfigPath(agent.id), { runCommand: options.runCommand });
      if (!result.ok) {
        log("error", `${label}: spawn failed, no heartbeat recorded: ${result.error}`);
      } else {
        // Deliberately no heartbeat here — a zero exit from the launcher
        // is evidence the launch command ran, not evidence the agent is
        // alive. The next cycle's fresh listing + independent pid check is
        // what actually proves it and records the heartbeat.
        log("info", `${label}: spawn launched; will confirm and record a heartbeat once it is independently verified alive`);
      }
      return registry;
    }
    case "not-subject":
      // The condition this agent may have previously been warned about
      // (T2) has cleared (no live session under its directory any more, or
      // it just isn't `on`) — drop any stale suppression entry so a real
      // recurrence warns again rather than being silently swallowed.
      options.unexpectedSessionWarnings.delete(agent.id);
      return registry;
    case "unexpected-session": {
      // T2's no-repeat rule: only log when the set of offending session
      // ids actually changed since the last warning for this agent.
      const signature = [...action.sessionIds].sort().join(",");
      if (options.unexpectedSessionWarnings.get(agent.id) !== signature) {
        log("warn", `${label}: ${action.reason}`);
        options.unexpectedSessionWarnings.set(agent.id, signature);
      }
      return registry;
    }
  }
}

export async function runReconcileCycle(options: SupervisorOptions): Promise<void> {
  const loaded = await loadAgentSet(options.agentSetPath);

  if (loaded.kind === "malformed") {
    // T1: a malformed agent set is a distinct typed failure and must never
    // be treated as "no agents" — skip the WHOLE cycle (heartbeat store
    // and registry untouched) and let the next scheduled tick try again.
    log(
      "error",
      `agent set at "${options.agentSetPath}" is malformed, skipping this entire reconcile cycle (never treated as "no agents"): ${loaded.error}`
    );
    return;
  }

  // "missing" (first run, zero agents) and "loaded" both proceed normally
  // from here — "missing" is a genuine success per T1, not an error.
  const agents = Object.values(loaded.agentSet.agents);

  // T3: only `on` agents are heartbeat subjects; an agent that leaves `on`
  // (turned off, archived, or deleted between cycles) must stop being one.
  const onIds = new Set<string>();
  for (const agent of agents) {
    if (agent.state === "on") {
      onIds.add(agent.id);
      options.heartbeatStore.registerSubject(agent.id, agent.name);
    }
  }
  for (const trackedId of options.heartbeatStore.listTrackedSubjects()) {
    if (!onIds.has(trackedId)) {
      options.heartbeatStore.unregisterSubject(trackedId);
    }
  }

  let registry = await loadRegistry(options.registryPath);

  let backgroundAgents: BackgroundAgentInfo[] | undefined;
  let listError: unknown;
  try {
    backgroundAgents = await listBackgroundAgents(options.runCommand);
  } catch (err) {
    listError = err;
  }

  // Sequential, not concurrent: keeps "one bad entry does not affect
  // others" obviously true by construction, and matters more here than the
  // latency of a few `systemd-run` calls at the agent-set sizes this
  // product targets — a handful of very-long-lived specialty agents, not
  // hundreds.
  for (const agent of agents) {
    try {
      registry = await reconcileOneAgent(agent, registry, backgroundAgents, listError, options);
    } catch (err) {
      log("error", `${agentLabel(agent)}: reconcile threw and was caught, no heartbeat recorded, other agents unaffected: ${String(err)}`);
    }
  }

  await saveRegistry(options.registryPath, registry);
}
