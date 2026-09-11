// CNDLX-27 section 2 / CNDLX-32: THE contract module. CNDLX-28 (the CLI,
// built in parallel against this exact file) imports the socket-path
// resolver, the route table, and the wire types from HERE rather than each
// side restating them — so the two surfaces cannot disagree about where
// the socket is, what routes exist, or what a response body looks like.
//
// Per CNDLX-27's doc: "the response body is authoritative and is the
// action's own result union, serialized as-is" — so the wire *response*
// types below are plain re-exports of the action-set's own result types
// (agent-actions.ts, attach-target.ts, open-terminal.ts), never a second,
// parallel set of types that could drift from what the server actually
// executes. Only *request* bodies (what a client sends) and the
// route/status tables are genuinely new here.

export { apiSocketPath } from "../paths";

import type { AgentRecord } from "../agent";
import type {
  ArchiveAgentResult,
  CreateAgentResult,
  DeleteAgentResult,
  ListAgentsResult,
  OffAgentResult,
  OnAgentResult,
  RenameAgentResult,
  UnarchiveAgentResult,
} from "../agent-actions";
import type { AttachTargetResult } from "../attach-target";
import type { OpenTerminalResult } from "../open-terminal";
import type { AnyActionError } from "../error-wire-format";

export type { AgentRecord };
export type {
  ArchiveAgentResult,
  CreateAgentResult,
  DeleteAgentResult,
  ListAgentsResult,
  OffAgentResult,
  OnAgentResult,
  RenameAgentResult,
  UnarchiveAgentResult,
};
export type { AttachTargetResult };
export type { OpenTerminalResult };

// ---------------------------------------------------------------------------
// Request bodies — the only genuinely NEW wire shapes (responses are the
// action set's own result types, imported above, not restated).
// ---------------------------------------------------------------------------

/** POST /v1/agents. `job` exists ONLY here (R3) — no route below accepts it. */
export interface CreateAgentRequestBody {
  name?: string;
  job?: string;
}

/** POST /v1/agents/{idOrName}/rename */
export interface RenameAgentRequestBody {
  name: string;
}

// ---------------------------------------------------------------------------
// The route table (CNDLX-27 section 2's table, verbatim). `{idOrName}` is
// ONE URL-encoded path segment. Every path here is additive-friendly:
// CNDLX-26 will plausibly add `/v1/agents/{id}/...` sub-resources later,
// and nothing here forecloses that — no MCP route or field ships in this
// task, deliberately.
// ---------------------------------------------------------------------------

export type ApiRouteName =
  | "listAgents"
  | "createAgent"
  | "turnOn"
  | "turnOff"
  | "archiveAgent"
  | "unarchiveAgent"
  | "deleteAgent"
  | "renameAgent"
  | "attachTarget"
  | "openTerminal";

export interface ApiRouteDef {
  method: "GET" | "POST";
  /** `:idOrName` marks the one path segment a handler URL-decodes and resolves. */
  pathTemplate: string;
}

export const API_ROUTES: Record<ApiRouteName, ApiRouteDef> = {
  listAgents: { method: "GET", pathTemplate: "/v1/agents" },
  createAgent: { method: "POST", pathTemplate: "/v1/agents" },
  turnOn: { method: "POST", pathTemplate: "/v1/agents/:idOrName/on" },
  turnOff: { method: "POST", pathTemplate: "/v1/agents/:idOrName/off" },
  archiveAgent: { method: "POST", pathTemplate: "/v1/agents/:idOrName/archive" },
  unarchiveAgent: { method: "POST", pathTemplate: "/v1/agents/:idOrName/unarchive" },
  deleteAgent: { method: "POST", pathTemplate: "/v1/agents/:idOrName/delete" },
  renameAgent: { method: "POST", pathTemplate: "/v1/agents/:idOrName/rename" },
  attachTarget: { method: "GET", pathTemplate: "/v1/agents/:idOrName/attach-target" },
  openTerminal: { method: "POST", pathTemplate: "/v1/agents/:idOrName/open-terminal" },
};

// ---------------------------------------------------------------------------
// API-server-specific typed refusals — not part of any action's own result
// union (they happen before an action is ever reached), but held to the
// exact same R8 standard: a server-produced `message`, typed `kind`.
// ---------------------------------------------------------------------------

export type UnknownRouteError = { kind: "unknown-route"; method: string; path: string; message: string };
export type MalformedJsonError = { kind: "malformed-json"; message: string };
export type InvalidRequestBodyError = { kind: "invalid-request-body"; message: string };
/** CNDLX-33 defect 1a: `{idOrName}` failed to `decodeURIComponent` — a malformed percent-escape, never reachable as an HTML 500 page. */
export type MalformedPathError = { kind: "malformed-path"; message: string };
/** CNDLX-33 defect 1b: the catch-all for any unexpected throw on the request path — logged server-side (src/log.ts), never a stack trace to the client. */
export type InternalServerError = { kind: "internal-error"; message: string };

export type ApiServerError = UnknownRouteError | MalformedJsonError | InvalidRequestBodyError | MalformedPathError | InternalServerError;

// ---------------------------------------------------------------------------
// Status mapping — "a coarse hint, not the contract" (CNDLX-27 section 2):
// 200 for ok:true, 4xx for a refusal or malformed request, 5xx for
// daemon-side trouble. A client reading only the body must be fully
// correct without ever consulting this table; it exists for tooling
// (curl, browser devtools, logs) that finds a status line convenient.
// Documented again, verbatim, in the README's API section.
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<AnyActionError["kind"] | ApiServerError["kind"], number> = {
  // 4xx — refusals / malformed input, all client-actionable.
  "not-found": 404,
  ambiguous: 409,
  "invalid-name": 400,
  "reserved-name": 400,
  "name-taken": 409,
  "already-archived": 409,
  archived: 409,
  "not-archived": 409,
  off: 409,
  "no-live-session": 409,
  "multiple-live-sessions": 409,
  "not-implemented": 501,
  "unknown-route": 404,
  "malformed-json": 400,
  "invalid-request-body": 400,
  "malformed-path": 400,
  "invalid-job": 400,
  // 5xx — daemon-side trouble: the store, a session lookup/cleanup, a
  // directory operation, or spawning a session failed. None of these are
  // the client's fault or fixable by changing the request.
  "store-malformed": 500,
  "store-write-failed": 500,
  "session-lookup-failed": 500,
  "session-cleanup-failed": 500,
  "directory-create-failed": 500,
  "spawn-failed": 500,
  "directory-removal-failed": 500,
  "internal-error": 500,
};

/** Pure: kind in, HTTP status out. Exhaustive over the same two kind-unions `ERROR_STATUS` is keyed by — a kind missing from either fails `bun run typecheck`. */
export function statusForErrorKind(kind: AnyActionError["kind"] | ApiServerError["kind"]): number {
  return ERROR_STATUS[kind];
}

export const OK_STATUS = 200;
