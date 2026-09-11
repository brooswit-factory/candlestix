// TEMPORARY — CNDLX-30's own restatement of a contract it does not own.
//
// This file is a placeholder. The daemon API, its socket, its route table
// and its wire types are CNDLX-27's story (running in parallel with this
// one against the same contract, section 2 of both stories' tickets).
// Everything below is CNDLX-30's best-effort restatement of that contract
// so the CLI can be built and tested against a fake server before
// CNDLX-27 has merged anything real.
//
// WHEN CNDLX-27 MERGES (CNDLX-31's job, not this file's):
//   - delete this file outright;
//   - replace every import of it, across the CLI, with an import of
//     CNDLX-27's real contract module;
//   - reconcile every wire type below against what CNDLX-27 actually
//     shipped (field names on attach-target in particular — this file
//     guesses at them because no server exists yet to verify against).
// Every other CLI module (grammar, rendering, confirmation, the attach
// hand-off, main) imports ONLY from this file for anything contract-shaped,
// so that swap should be one import changed per file, never a rewrite.
//
// The socket-path resolver below is ALSO provisional: CNDLX-27's ticket
// says the real path comes from one resolver function added to
// src/xdg.ts, shared by the daemon and the CLI so they cannot disagree.
// That function does not exist in this tree yet. This module computes an
// equivalent path itself, by calling the XDG primitives that DO already
// exist (`xdg.candlestixRuntimeDir`, which CNDLX-14 shipped and this file
// does not own or modify) and appending a guessed socket filename. This is
// exactly the kind of restatement this file exists to hold, and exactly
// what gets deleted when CNDLX-27's real resolver lands.

import { homedir, tmpdir } from "node:os";
import * as xdg from "./xdg";
import type { AgentRecord } from "./agent";

// Mirrors src/paths.ts's private `currentXdgInputs` — duplicated here
// rather than imported because that function is not exported, and because
// this whole module is meant to disappear in one piece rather than gain a
// permanent dependency on paths.ts's internals.
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function currentXdgInputs(): xdg.XdgInputs {
  return {
    home: homedir(),
    configHome: nonEmpty(process.env["XDG_CONFIG_HOME"]),
    stateHome: nonEmpty(process.env["XDG_STATE_HOME"]),
    runtimeDir: nonEmpty(process.env["XDG_RUNTIME_DIR"]),
    runtimeFallbackBase: `${tmpdir()}/candlestix-${process.getuid?.() ?? "nouid"}`,
  };
}

/**
 * Guessed filename for the daemon's Unix socket, under
 * `xdg.candlestixRuntimeDir` (which already exists and is not provisional).
 * CNDLX-27 owns the real name; verify it matches once that story merges,
 * and delete this whole function in favour of CNDLX-27's resolver then.
 */
export function resolveSocketPath(): string {
  return `${xdg.candlestixRuntimeDir(currentXdgInputs())}/candlestix.sock`;
}

// ---------------------------------------------------------------------------
// Wire envelope — the shape CNDLX-27's ticket specifies verbatim: the
// action set's own result unions, serialized as-is.
// ---------------------------------------------------------------------------

/**
 * CNDLX-27's own R8 checklist names several action-set error variants that,
 * at CNDLX-14's merged commit, carry no `message` field at all. CNDLX-27 is
 * tasked with closing that gap before every error reaches the wire; this
 * client's rule (see src/cli/render.ts) is to print `message` verbatim when
 * present and fall back to a single generic, kind-naming line when it is
 * not — never inventing per-kind wording of its own (R8).
 */
export interface ApiErrorBody {
  kind: string;
  message?: string;
}

export type ApiEnvelope<TSuccess> = ({ ok: true } & TSuccess) | { ok: false; error: ApiErrorBody };

/**
 * The wire shape of an agent record. Imported as a TYPE ONLY from the core
 * module CNDLX-14 shipped (`src/agent.ts`) — no function from that module,
 * or from any store/action module, is imported anywhere in the CLI. This is
 * the one core type this file (and the epic's own ticket) explicitly
 * sanctions sharing: "if you need them for types only, the result-union
 * types [...] importing a type is fine; importing a function that reads or
 * writes the store is not."
 */
export type WireAgent = AgentRecord;

export interface CreateAgentBody {
  name?: string;
  job?: string;
}

export type CreateAgentSuccess = { agent: WireAgent };
export type CreateAgentEnvelope = ApiEnvelope<CreateAgentSuccess>;

export type ListAgentsSuccess = { agents: WireAgent[] };
export type ListAgentsEnvelope = ApiEnvelope<ListAgentsSuccess>;

/**
 * `on` / `off` / `archive` / `unarchive` / `delete` all share this shape:
 * a typed outcome discriminated by `kind` (R6's "no change" success is one
 * such kind, e.g. `{ kind: "no-change" }` next to `{ kind: "turned-off" }`).
 * The CLI only ever switches on `outcome.kind` as an opaque string; it does
 * not hardcode the full enumeration here, so a kind this file did not
 * anticipate still renders (generically) rather than being silently
 * dropped.
 */
export type LifecycleActionSuccess = { outcome: { kind: string } };
export type LifecycleActionEnvelope = ApiEnvelope<LifecycleActionSuccess>;

export interface RenameAgentBody {
  name: string;
}

export type RenameAgentSuccess = { agent: WireAgent };
export type RenameAgentEnvelope = ApiEnvelope<RenameAgentSuccess>;

/**
 * GUESSED field names — no server exists yet to verify against. CNDLX-27's
 * ticket promises "the session's short id (what `claude attach <id>`
 * takes) [...] plus the full session id" and the agent's id and name.
 * Verify every field name here against CNDLX-27's actual response shape at
 * rebase time (CNDLX-31); this is exactly the kind of guess this file
 * exists to hold instead of the CLI's real logic.
 */
export type AttachTargetSuccess = {
  agentId: string;
  name?: string;
  sessionShortId: string;
  sessionId: string;
};
export type AttachTargetEnvelope = ApiEnvelope<AttachTargetSuccess>;

// ---------------------------------------------------------------------------
// Route table — section 2 of both stories' tickets, verbatim.
// ---------------------------------------------------------------------------

export type LifecycleAction = "on" | "off" | "archive" | "unarchive" | "delete";

export const AGENTS_COLLECTION_PATH = "/v1/agents";

/** `{idOrName}` is one URL-encoded path segment — encoded here, in the one place every route is built. */
export function agentActionPath(idOrName: string, action: LifecycleAction): string {
  return `${AGENTS_COLLECTION_PATH}/${encodeURIComponent(idOrName)}/${action}`;
}

export function agentRenamePath(idOrName: string): string {
  return `${AGENTS_COLLECTION_PATH}/${encodeURIComponent(idOrName)}/rename`;
}

export function agentAttachTargetPath(idOrName: string): string {
  return `${AGENTS_COLLECTION_PATH}/${encodeURIComponent(idOrName)}/attach-target`;
}

// open-terminal deliberately has no path builder here: it is webapp-only
// (CNDLX-3's endpoint, defined by CNDLX-27) and is explicitly NOT a CLI verb.
