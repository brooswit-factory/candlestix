// Orchestrates one CLI invocation end to end: parse argv, call the daemon,
// render the result, decide the exit code. Every external effect (writing
// to a stream, reading a confirmation line, spawning `claude attach`, the
// API client itself) arrives via `CliDeps`, so `runCli` is fully
// unit-testable against a fake server and fake I/O — src/cli/bin.ts is the
// one place that wires real `process.stdin`/`stdout`/argv to this.

import type { ApiClient } from "./api-client";
import { resolveDeleteConfirmation } from "./confirm";
import { performAttachHandoff } from "./attach";
import { EXIT_REFUSAL, EXIT_SUCCESS } from "./exit-codes";
import { parseArgv, type ParsedCommand } from "./grammar";
import { fromCallResult, renderProtocolError, renderRefusal, renderUnreachable, usageErrorOutcome, type Outcome } from "./render";

export interface CliIO {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Only ever called when `stdinIsTTY` is true — see src/cli/confirm.ts. */
  promptAndReadLine: (promptText: string) => Promise<string>;
  /** Runs `claude attach <id>` with stdio inherited; resolves to the child's exit code. Only ever called when both `stdinIsTTY` and `stdoutIsTTY` are true — see src/cli/attach.ts. */
  spawnAttach: (sessionShortId: string) => Promise<number>;
}

export interface CliDeps {
  apiClient: ApiClient;
  io: CliIO;
}

function emit(outcome: Outcome, io: CliIO): void {
  if (outcome.stdout !== undefined) io.writeStdout(outcome.stdout);
  if (outcome.stderr !== undefined) io.writeStderr(outcome.stderr);
}

function renderLifecycleOutcome(verb: "on" | "off" | "archive" | "unarchive", outcomeKind: string): string {
  // R6: the no-change diagonal renders distinctly from both a real
  // transition and a refusal. `on`/`off` are the only verbs with a
  // no-change branch (agent-lifecycle.ts's decideArchive/decideUnarchive
  // have none) but this stays generic rather than assuming that forever.
  if (outcomeKind === "no-change") {
    return verb === "on" || verb === "off" ? `already ${verb}` : `already ${verb}d`;
  }
  return outcomeKind.replace(/-/g, " "); // "turned-on" -> "turned on", "archived" -> "archived", ...
}

async function handleCreate(command: Extract<ParsedCommand, { kind: "create" }>, deps: CliDeps): Promise<Outcome> {
  const result = await deps.apiClient.createAgent({
    ...(command.name !== undefined ? { name: command.name } : {}),
    ...(command.job !== undefined ? { job: command.job } : {}),
  });
  return fromCallResult(result, (body) => {
    const agent = body.agent;
    const label = agent.name !== undefined ? `${agent.id} (name: "${agent.name}")` : agent.id;
    return { exitCode: EXIT_SUCCESS, stdout: `Created ${label}\nAttach with: candlestix ${agent.id}\n` };
  });
}

async function handleList(command: Extract<ParsedCommand, { kind: "list" }>, deps: CliDeps): Promise<Outcome> {
  const result = await deps.apiClient.listAgents();
  return fromCallResult(result, (body) => {
    const agents = body.agents.filter((a) => command.showArchived || a.state !== "archived");
    if (agents.length === 0) return { exitCode: EXIT_SUCCESS, stdout: "No agents.\n" };
    const lines = agents
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => `${a.id}${a.name !== undefined ? ` "${a.name}"` : ""} — ${a.state}`);
    return { exitCode: EXIT_SUCCESS, stdout: lines.join("\n") + "\n" };
  });
}

async function handleLifecycle(command: Extract<ParsedCommand, { kind: "on" | "off" | "archive" | "unarchive" }>, deps: CliDeps): Promise<Outcome> {
  const result = await deps.apiClient.lifecycleAction(command.idOrName, command.kind);
  return fromCallResult(result, (body) => ({
    exitCode: EXIT_SUCCESS,
    stdout: `${renderLifecycleOutcome(command.kind, body.outcome.kind)}\n`,
  }));
}

async function handleRename(command: Extract<ParsedCommand, { kind: "rename" }>, deps: CliDeps): Promise<Outcome> {
  const result = await deps.apiClient.renameAgent(command.idOrName, { name: command.newName });
  return fromCallResult(result, (body) => ({
    exitCode: EXIT_SUCCESS,
    stdout: `Renamed ${body.agent.id} to "${body.agent.name}"\n`,
  }));
}

/** Best-effort, display-only: find a matching agent in an already-fetched list, id first then name, purely to enrich the delete confirmation prompt. Never authoritative — the daemon resolves the real target when the delete call itself is made. */
function findForDisplay<T extends { id: string; name?: string }>(agents: T[], query: string): T | undefined {
  return agents.find((a) => a.id === query) ?? agents.find((a) => a.name === query);
}

async function handleDelete(command: Extract<ParsedCommand, { kind: "delete" }>, deps: CliDeps): Promise<Outcome> {
  let description = `"${command.idOrName}"`;
  // Only bother enriching the description when a TTY prompt will actually
  // be shown — --yes and non-TTY-refused paths never display it.
  if (!command.yes && deps.io.stdinIsTTY) {
    const listResult = await deps.apiClient.listAgents();
    if (listResult.transport === "ok" && listResult.body.ok) {
      const match = findForDisplay(listResult.body.agents, command.idOrName);
      if (match !== undefined) {
        description = match.name !== undefined ? `${match.id} (name: "${match.name}")` : match.id;
      }
    }
  }

  const confirmation = await resolveDeleteConfirmation(
    { yes: command.yes, agentDescription: description },
    { stdinIsTTY: deps.io.stdinIsTTY, promptAndReadLine: deps.io.promptAndReadLine }
  );

  if (confirmation.kind === "refused") {
    return { exitCode: EXIT_REFUSAL, stderr: `${confirmation.message}\n` };
  }
  if (confirmation.kind === "declined") {
    return { exitCode: EXIT_REFUSAL, stdout: "Delete cancelled (not confirmed).\n" };
  }

  const result = await deps.apiClient.lifecycleAction(command.idOrName, "delete");
  return fromCallResult(result, () => ({ exitCode: EXIT_SUCCESS, stdout: `Deleted ${description}\n` }));
}

/**
 * R18 end to end, in the CLI: query attach-target; a refusal (off,
 * archived, not-found, zero/several sessions) is printed verbatim and
 * never starts anything (never silently turns an off agent on). Only on
 * success does this reach the actual terminal hand-off, whose own non-TTY
 * refusal is a separate, later decision (src/cli/attach.ts) — matching the
 * ticket's own numbered ordering (query first, THEN decide about the
 * terminal).
 */
async function handleAttach(command: Extract<ParsedCommand, { kind: "attach" }>, deps: CliDeps): Promise<Outcome> {
  const result = await deps.apiClient.attachTarget(command.idOrName);
  if (result.transport === "unreachable") return renderUnreachable(result);
  if (result.transport === "protocol-error") return renderProtocolError(result);
  const body = result.body;
  if (!body.ok) return renderRefusal(body.error);

  const handoff = await performAttachHandoff(body.target.sessionShortId, {
    stdinIsTTY: deps.io.stdinIsTTY,
    stdoutIsTTY: deps.io.stdoutIsTTY,
    spawnAttach: deps.io.spawnAttach,
  });
  if (handoff.kind === "refused-non-tty") {
    return { exitCode: EXIT_REFUSAL, stderr: `${handoff.message}\n` };
  }
  // The epic's explicit ruling: from here on the process's exit status IS
  // `claude attach`'s own, unmodified — even if it collides with one of
  // candlestix's own four codes above. See src/cli/exit-codes.ts.
  return { exitCode: handoff.exitCode };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    const outcome = usageErrorOutcome(parsed.error.message);
    emit(outcome, deps.io);
    return outcome.exitCode;
  }

  const command = parsed.command;
  let outcome: Outcome;
  switch (command.kind) {
    case "create":
      outcome = await handleCreate(command, deps);
      break;
    case "list":
      outcome = await handleList(command, deps);
      break;
    case "on":
    case "off":
    case "archive":
    case "unarchive":
      outcome = await handleLifecycle(command, deps);
      break;
    case "rename":
      outcome = await handleRename(command, deps);
      break;
    case "delete":
      outcome = await handleDelete(command, deps);
      break;
    case "attach":
      outcome = await handleAttach(command, deps);
      break;
  }
  emit(outcome, deps.io);
  return outcome.exitCode;
}
