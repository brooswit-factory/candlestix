// The CLI's thin HTTP-over-Unix-socket client. Speaks HTTP/1.1 with JSON
// bodies to the daemon's socket (CNDLX-27's contract, restated in
// src/api-contract.ts). Never touches the store, never imports an
// action/store module for anything but a type — this file's only import
// from core is api-contract.ts, which itself only type-imports AgentRecord.
//
// Uses `node:http`'s `socketPath` option rather than `Bun.fetch`'s `unix`
// option: both exist at the locally available bun (1.3.14); `node:http` is
// the more conservative, longer-established surface, so it is the one
// documented here as needing verification at 1.3.11 (see the PR
// description). Verified locally: a GET/POST round trip against a
// `Bun.serve({unix, fetch})` fake server works end to end (see this
// story's test suite).
//
// A note on distinguishing "socket file absent" from "socket present but
// refused" (the DoD's daemon-down cases): `node:http`'s Unix-socket error
// path, verified locally, collapses BOTH cases (and even "path exists but
// is not a socket at all") to the same generic connect-error — there is no
// reliable `err.code` to switch on. So this module does the cheap thing
// the ticket allows instead: after a connect failure, `stat` the socket
// path itself. That is a best-effort, separately-racy check (the file
// could appear or disappear between the two calls) but is enough to tell
// an operator "never started" from "died, left a file behind" in the
// common case.

import * as http from "node:http";
import { stat } from "node:fs/promises";
import {
  AGENTS_COLLECTION_PATH,
  agentActionPath,
  agentAttachTargetPath,
  agentRenamePath,
  type AttachTargetEnvelope,
  type CreateAgentBody,
  type CreateAgentEnvelope,
  type LifecycleAction,
  type LifecycleActionEnvelope,
  type ListAgentsEnvelope,
  type RenameAgentBody,
  type RenameAgentEnvelope,
} from "../api-contract";

export interface TransportUnreachable {
  transport: "unreachable";
  socketPath: string;
  /** Best-effort: whether a file exists at `socketPath` right now. See module doc comment for the race this cannot close. */
  socketFilePresent: boolean;
  detail: string;
}

/** The daemon responded, but not with something this client can make sense of — never conflated with an ordinary API refusal, which always parses cleanly. */
export interface TransportProtocolError {
  transport: "protocol-error";
  detail: string;
}

export interface TransportOk<T> {
  transport: "ok";
  status: number;
  body: T;
}

export type CallResult<T> = TransportUnreachable | TransportProtocolError | TransportOk<T>;

export interface ApiClientDeps {
  socketPath: string;
  timeoutMs?: number;
}

async function socketFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type RawResult = { kind: "response"; status: number; text: string } | { kind: "error"; detail: string };

function rawRequest(method: string, path: string, jsonBody: unknown | undefined, deps: ApiClientDeps): Promise<RawResult> {
  return new Promise((resolve) => {
    const bodyText = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
    const headers: Record<string, string> = {};
    if (bodyText !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(bodyText));
    }

    const req = http.request(
      {
        socketPath: deps.socketPath,
        path,
        method,
        headers,
        timeout: deps.timeoutMs ?? 10_000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve({ kind: "response", status: res.statusCode ?? 0, text: data }));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`request to ${path} timed out after ${deps.timeoutMs ?? 10_000}ms`));
    });
    req.on("error", (err: Error) => resolve({ kind: "error", detail: err.message }));
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

async function call<T>(method: string, path: string, jsonBody: unknown | undefined, deps: ApiClientDeps): Promise<CallResult<T>> {
  const result = await rawRequest(method, path, jsonBody, deps);
  if (result.kind === "error") {
    const present = await socketFileExists(deps.socketPath);
    return { transport: "unreachable", socketPath: deps.socketPath, socketFilePresent: present, detail: result.detail };
  }

  let parsed: unknown;
  try {
    parsed = result.text.length > 0 ? JSON.parse(result.text) : undefined;
  } catch (err) {
    return {
      transport: "protocol-error",
      detail: `daemon response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    return {
      transport: "protocol-error",
      detail: `daemon response did not have the expected {"ok": ...} envelope shape: ${JSON.stringify(parsed)}`,
    };
  }
  return { transport: "ok", status: result.status, body: parsed as T };
}

export function createApiClient(deps: ApiClientDeps) {
  return {
    createAgent: (body: CreateAgentBody): Promise<CallResult<CreateAgentEnvelope>> => call("POST", AGENTS_COLLECTION_PATH, body, deps),
    listAgents: (): Promise<CallResult<ListAgentsEnvelope>> => call("GET", AGENTS_COLLECTION_PATH, undefined, deps),
    lifecycleAction: (idOrName: string, action: LifecycleAction): Promise<CallResult<LifecycleActionEnvelope>> =>
      call("POST", agentActionPath(idOrName, action), undefined, deps),
    renameAgent: (idOrName: string, body: RenameAgentBody): Promise<CallResult<RenameAgentEnvelope>> =>
      call("POST", agentRenamePath(idOrName), body, deps),
    attachTarget: (idOrName: string): Promise<CallResult<AttachTargetEnvelope>> =>
      call("GET", agentAttachTargetPath(idOrName), undefined, deps),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
