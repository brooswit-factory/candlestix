// CNDLX-27 section 1 + CNDLX-32: the daemon's HTTP-over-Unix-socket API
// server. Every route in contract.ts's table, wired to the SAME action-set
// functions the daemon's own reconcile loop is built on top of (no second
// implementation of any verb) — mutating verbs run through a single
// `MutationQueue` (mutation-queue.ts) so two concurrent requests cannot
// silently lose one's update to the durable agent set (CNDLX-27 section
// 5). `list`, `attach-target`, and `open-terminal` are read-only queries
// and are NOT queued — there is no read-modify-write for the queue to
// protect there, and attach-target's own "two attaches at once is
// correct, candlestix does not arbitrate" ruling means it must not be
// serialized even incidentally by sharing the mutation queue's tail.
//
// Startup steal-protection (section 1): a leftover socket file that
// nothing accepts on is removed and re-bound; a socket something IS
// accepting on means another daemon for this user is already running —
// this refuses to start rather than stealing it. Verified live (see the
// commit history / PR description for the exact commands): `Bun.serve`
// itself does NOT refuse to bind over a live listener's socket file — it
// silently unlinks and rebinds, which is exactly the "steal" this section
// forbids — so the liveness probe below runs BEFORE calling `Bun.serve`,
// never after.

import { chmod, mkdir, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentActionsDeps } from "../agent-actions";
import { archiveAgent, createAgent, deleteAgent, listAgents, renameAgent, turnOff, turnOn, unarchiveAgent } from "../agent-actions";
import { attachTargetDepsFrom, getAttachTarget } from "../attach-target";
import { getOpenTerminalTarget } from "../open-terminal";
import { pathExists } from "../registry-store";
import { createMutationQueue, type MutationQueue } from "../mutation-queue";
import type { AnyActionError } from "../error-wire-format";
import { API_ROUTES, OK_STATUS, statusForErrorKind, type ApiRouteName, type ApiServerError, type CreateAgentRequestBody, type RenameAgentRequestBody } from "./contract";

// ---------------------------------------------------------------------------
// Startup: refuse-to-steal / reclaim-if-stale
// ---------------------------------------------------------------------------

/**
 * Probes whether something is genuinely LISTENING on `path`, independent of
 * whether the file exists — a Unix socket file can outlive the process that
 * bound it (the OS does not clean it up when the listener dies). Connecting
 * and succeeding means live; connecting and failing (ECONNREFUSED — nothing
 * accepting) means stale. Verified empirically at this ticket's own bun
 * version (see PR description): a genuinely dead listener's socket file
 * reliably fails a fresh `Bun.connect`, and a live one reliably succeeds.
 */
async function isSocketLive(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export type StartApiServerError = { kind: "socket-in-use"; path: string; message: string };
export type StartApiServerResult = { ok: true; handle: ApiServerHandle } | { ok: false; error: StartApiServerError };

export interface ApiServerHandle {
  socketPath: string;
  /** Stops accepting new connections and removes the socket file (clean shutdown, section 1). */
  stop: () => void;
}

export async function startApiServer(deps: AgentActionsDeps, socketPath: string): Promise<StartApiServerResult> {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true });
  // `mkdir`'s own `mode` is subject to umask and is a no-op if the
  // directory already existed (e.g. created earlier by registry-store.ts /
  // health/signal.ts without this requirement) — an explicit `chmod`
  // afterwards is what actually guarantees 0700 regardless of umask or
  // creation order. Asserted by `stat` in the test, not assumed from this
  // call succeeding.
  await chmod(dir, 0o700);

  if (await pathExists(socketPath)) {
    const live = await isSocketLive(socketPath);
    if (live) {
      return {
        ok: false,
        error: {
          kind: "socket-in-use",
          path: socketPath,
          message: `refusing to start: another candlestix daemon for this user is already listening on "${socketPath}" — never stealing a live socket`,
        },
      };
    }
    // Stale: the file exists but nothing accepts on it (e.g. an unclean
    // shutdown). Removed explicitly, then re-bound below — never silently
    // left for `Bun.serve` to overwrite on its own, so the "removed and
    // re-bound" behaviour this section asks for is visible in this
    // function's own control flow, not an accident of the underlying bind
    // call's own behaviour (which, per this module's own doc comment,
    // would also happily overwrite a LIVE socket — the exact steal this
    // function exists to prevent by checking first).
    await unlink(socketPath).catch(() => {});
  }

  const mutationQueue = createMutationQueue();
  const server = Bun.serve({
    unix: socketPath,
    fetch: (req) => handleRequest(req, deps, mutationQueue),
  });

  // Socket file mode 0600 (section 1), asserted by `stat` in the test, not
  // assumed from this call not throwing.
  await chmod(socketPath, 0o600);

  return {
    ok: true,
    handle: {
      socketPath,
      stop: () => {
        server.stop();
        try {
          unlinkSync(socketPath);
        } catch {
          // best-effort: a socket already gone (e.g. removed out-of-band) is not a shutdown failure.
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface MatchedRoute {
  route: ApiRouteName;
  idOrName: string | undefined;
}

function matchRoute(method: string, pathname: string): MatchedRoute | undefined {
  const pathParts = pathname.split("/").filter((p) => p.length > 0);
  for (const [name, def] of Object.entries(API_ROUTES) as Array<[ApiRouteName, (typeof API_ROUTES)[ApiRouteName]]>) {
    if (def.method !== method) continue;
    const templateParts = def.pathTemplate.split("/").filter((p) => p.length > 0);
    if (templateParts.length !== pathParts.length) continue;
    let idOrName: string | undefined;
    let matched = true;
    for (let i = 0; i < templateParts.length; i++) {
      const templatePart = templateParts[i] as string;
      const pathPart = pathParts[i] as string;
      if (templatePart.startsWith(":")) {
        idOrName = decodeURIComponent(pathPart);
      } else if (templatePart !== pathPart) {
        matched = false;
        break;
      }
    }
    if (matched) return { route: name, idOrName };
  }
  return undefined;
}

/** A missing `:idOrName` on a route that has one in its template is a routing bug, not a user-facing case — see contract.ts's `API_ROUTES`. */
function requireIdOrName(matched: MatchedRoute): string {
  if (matched.idOrName === undefined) {
    throw new Error(`routing bug: route "${matched.route}" matched with no :idOrName captured`);
  }
  return matched.idOrName;
}

type ReadJsonBodyResult<T> = { ok: true; body: T | undefined } | { ok: false; error: ApiServerError };

/** Empty body is treated as `undefined`, not an error — every route that takes a body here has every field optional-or-defaulted except rename's `name`, which is validated by its own handler. */
async function readJsonBody<T>(req: Request): Promise<ReadJsonBodyResult<T>> {
  const text = await req.text();
  if (text.trim().length === 0) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      error: { kind: "malformed-json", message: `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The response body IS the action's own result union, serialized as-is (CNDLX-27 section 2) — this only picks the HTTP status alongside it. */
function jsonResult<E extends AnyActionError>(result: { ok: true } | { ok: false; error: E }): Response {
  const status = result.ok ? OK_STATUS : statusForErrorKind(result.error.kind);
  return jsonResponse(result, status);
}

function jsonServerError(error: ApiServerError): Response {
  return jsonResponse({ ok: false, error }, statusForErrorKind(error.kind));
}

export async function handleRequest(req: Request, deps: AgentActionsDeps, queue: MutationQueue): Promise<Response> {
  const url = new URL(req.url);
  const matched = matchRoute(req.method, url.pathname);
  if (!matched) {
    return jsonServerError({
      kind: "unknown-route",
      method: req.method,
      path: url.pathname,
      message: `no route matches ${req.method} ${url.pathname}`,
    });
  }

  const attachDeps = attachTargetDepsFrom(deps);

  switch (matched.route) {
    case "listAgents":
      return jsonResult(await listAgents(deps));

    case "createAgent": {
      const bodyResult = await readJsonBody<CreateAgentRequestBody>(req);
      if (!bodyResult.ok) return jsonServerError(bodyResult.error);
      const body = bodyResult.body ?? {};
      if (body.name !== undefined && typeof body.name !== "string") {
        return jsonServerError({ kind: "invalid-request-body", message: `"name" must be a string when present` });
      }
      if (body.job !== undefined && typeof body.job !== "string") {
        return jsonServerError({ kind: "invalid-request-body", message: `"job" must be a string when present` });
      }
      const result = await queue.run(() =>
        createAgent(deps, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.job !== undefined ? { job: body.job } : {}) })
      );
      return jsonResult(result);
    }

    case "turnOn":
      return jsonResult(await queue.run(() => turnOn(deps, requireIdOrName(matched))));

    case "turnOff":
      return jsonResult(await queue.run(() => turnOff(deps, requireIdOrName(matched))));

    case "archiveAgent":
      return jsonResult(await queue.run(() => archiveAgent(deps, requireIdOrName(matched))));

    case "unarchiveAgent":
      return jsonResult(await queue.run(() => unarchiveAgent(deps, requireIdOrName(matched))));

    case "deleteAgent":
      return jsonResult(await queue.run(() => deleteAgent(deps, requireIdOrName(matched))));

    case "renameAgent": {
      const bodyResult = await readJsonBody<RenameAgentRequestBody>(req);
      if (!bodyResult.ok) return jsonServerError(bodyResult.error);
      const body = bodyResult.body;
      if (body === undefined || typeof body.name !== "string") {
        return jsonServerError({ kind: "invalid-request-body", message: `request body must be {"name": string}` });
      }
      const idOrName = requireIdOrName(matched);
      const result = await queue.run(() => renameAgent(deps, idOrName, body.name));
      return jsonResult(result);
    }

    case "attachTarget":
      return jsonResult(await getAttachTarget(attachDeps, requireIdOrName(matched)));

    case "openTerminal":
      return jsonResult(await getOpenTerminalTarget(attachDeps, requireIdOrName(matched)));
  }
}
