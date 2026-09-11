// Turns a CallResult (src/cli/api-client.ts) or a parse error into an
// Outcome: what to print, where, and what to exit with. Every refusal path
// funnels through here so there is exactly one place that decides "the
// API's error.message, verbatim, never our own wording" (R8), exactly one
// place that classifies a refusal's exit code (see classifyRefusalExitCode
// below), and exactly one place that implements the message-less-refusal
// fallback as a defensive guard.

import { statusForErrorKind } from "../api/contract";
import type { CallResult, TransportProtocolError, TransportUnreachable } from "./api-client";
import { EXIT_DAEMON_UNREACHABLE, EXIT_REFUSAL, EXIT_USAGE_ERROR } from "./exit-codes";

export interface Outcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function usageErrorOutcome(message: string): Outcome {
  return { exitCode: EXIT_USAGE_ERROR, stderr: `candlestix: usage error: ${message}\n` };
}

/**
 * `systemd/candlestix.service` in this repo is the real unit name candlestix
 * ships — read here rather than quoted from any ticket or from this
 * workspace's own ENVIRONMENT.md, which (per this story's brief) describes
 * a DIFFERENT daemon (butchr's) on this host, not candlestix's.
 */
const UNIT_NAME = "candlestix.service";

export function renderUnreachable(result: TransportUnreachable): Outcome {
  const presence = result.socketFilePresent
    ? "a socket file exists at that path, but the connection was refused — the daemon may have died and left the file behind"
    : "no socket file exists at that path — the daemon has probably never been started";
  return {
    exitCode: EXIT_DAEMON_UNREACHABLE,
    stderr:
      `candlestix: cannot reach the candlestix daemon.\n` +
      `  socket path tried: ${result.socketPath}\n` +
      `  ${presence}\n` +
      `  detail: ${result.detail}\n` +
      `  check the daemon: systemctl --user status ${UNIT_NAME} (it is a user unit — a system-level "journalctl -u ${UNIT_NAME}" prints "-- No entries --" rather than an error; use "journalctl --user -u ${UNIT_NAME}").\n`,
  };
}

export function renderProtocolError(result: TransportProtocolError): Outcome {
  return {
    exitCode: EXIT_DAEMON_UNREACHABLE,
    stderr: `candlestix: the daemon responded, but its response could not be understood: ${result.detail}\n`,
  };
}

/**
 * The epic's settled exit-code ruling: exit `1` means "candlestix asked and
 * was told no" (a refusal, including a delete the operator declined); exit
 * `3` means "the daemon could not serve the request" — unreachable, an
 * unintelligible response, OR a daemon-side failure. The server's own
 * `message` is still printed verbatim either way; only the exit code
 * changes. Classified through the contract's own `statusForErrorKind` —
 * never a hand-written list of daemon-side kinds here, which would drift
 * from the server's union the moment a kind is added (R17's one-list
 * principle, applied to exit codes instead of names).
 */
function classifyRefusalExitCode(kind: string): number {
  // Bridge: this CLI treats `kind` as an opaque string (a newer daemon may
  // send a kind this build's own contract union does not list), while
  // `statusForErrorKind`'s TypeScript signature accepts only known kinds.
  // The cast is safe specifically because the real implementation is a
  // plain object index (`ERROR_STATUS[kind]`), which returns `undefined`
  // for a key outside the table at RUNTIME regardless of what the return
  // type claims — so the `undefined` branch immediately below is genuinely
  // reachable, not defensive dead code.
  const status = statusForErrorKind(kind as Parameters<typeof statusForErrorKind>[0]);
  // THE TRAP: in JavaScript, `undefined >= 500` is `false`. The obvious
  // `status >= 500 ? EXIT_DAEMON_UNREACHABLE : EXIT_REFUSAL` would
  // therefore send an unrecognised kind to EXIT_REFUSAL — the exact
  // opposite of the ruling. An unrecognised kind is a response this CLI
  // cannot fully understand (a newer daemon, an older CLI), so it is
  // daemon-side trouble too; handled as its own explicit branch rather
  // than by falling through the `>=` comparison.
  if (status === undefined || status >= 500) return EXIT_DAEMON_UNREACHABLE;
  return EXIT_REFUSAL;
}

/** The minimal shape this module defends against when rendering any refusal — deliberately NOT one of the contract's own error union members, so this boundary still holds even against a `kind` or a missing `message` no current build of the contract anticipates. */
export interface RefusalError {
  kind: string;
  message?: string;
}

/**
 * The message-less-refusal fallback (a defensive guard only): print
 * `error.message` verbatim whenever present (R8). When it is absent, this
 * is the ONE generic line the CLI is allowed to invent — it names the
 * `kind` and says plainly that the daemon sent no message, rather than
 * guessing per-kind wording of its own.
 *
 * EXPECTED NEVER TO FIRE against CNDLX-27's merged server: every error kind
 * reachable at the wire is verified (src/error-wire-format.ts, both at
 * compile time and at runtime) to carry a server-produced `message`. If
 * this branch is ever exercised against a real, merged daemon, that is a
 * CNDLX-27 defect to report — never something to paper over here with
 * invented wording.
 */
export function renderRefusal(error: RefusalError): Outcome {
  const exitCode = classifyRefusalExitCode(error.kind);
  if (error.message !== undefined) {
    return { exitCode, stderr: `${error.message}\n` };
  }
  return {
    exitCode,
    stderr: `candlestix: the daemon refused (${error.kind}) but sent no message. This should never happen against a correctly-behaving daemon — please report it.\n`,
  };
}

/**
 * Shared plumbing for every verb: unwraps transport-level trouble first
 * (unreachable, protocol-error), then the API's own `ok:false` refusal,
 * and only calls `onSuccess` once a genuine `ok:true` body is in hand.
 * Generic directly over one of the contract's own result-union types
 * (`CreateAgentResult`, `LifecycleActionResult`, ...) — there is no
 * separate `ApiEnvelope<T>` wrapper to keep in sync with them any more.
 */
export function fromCallResult<TBody extends { ok: true } | { ok: false; error: RefusalError }>(
  result: CallResult<TBody>,
  onSuccess: (body: Extract<TBody, { ok: true }>) => Outcome
): Outcome {
  if (result.transport === "unreachable") return renderUnreachable(result);
  if (result.transport === "protocol-error") return renderProtocolError(result);
  const body = result.body;
  if (body.ok) return onSuccess(body as Extract<TBody, { ok: true }>);
  return renderRefusal((body as Extract<TBody, { ok: false; error: RefusalError }>).error);
}
