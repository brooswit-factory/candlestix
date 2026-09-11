// Turns a CallResult (src/cli/api-client.ts) or a parse error into an
// Outcome: what to print, where, and what to exit with. Every refusal path
// funnels through here so there is exactly one place that decides "the
// API's error.message, verbatim, never our own wording" (R8) and exactly
// one place that implements the message-less-refusal fallback the epic
// requires as a defensive guard.

import type { ApiEnvelope, ApiErrorBody } from "../api-contract";
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
 * The message-less-refusal fallback (the epic's own requirement, a
 * defensive guard only): print `error.message` verbatim whenever present
 * (R8). When it is absent, this is the ONE generic line the CLI is allowed
 * to invent — it names the `kind` and says plainly that the daemon sent no
 * message, rather than guessing per-kind wording of its own.
 *
 * EXPECTED NEVER TO FIRE against CNDLX-27's merged server: CNDLX-27 is
 * tasked with ensuring every error that reaches the wire carries a
 * server-produced `message`. If this branch is ever exercised against a
 * real, merged daemon, that is a CNDLX-27 defect to report — never
 * something to paper over here with invented wording.
 */
export function renderRefusal(error: ApiErrorBody): Outcome {
  if (error.message !== undefined) {
    return { exitCode: EXIT_REFUSAL, stderr: `${error.message}\n` };
  }
  return {
    exitCode: EXIT_REFUSAL,
    stderr: `candlestix: the daemon refused (${error.kind}) but sent no message. This should never happen against a correctly-behaving daemon — please report it.\n`,
  };
}

/**
 * Shared plumbing for every verb: unwraps transport-level trouble first
 * (unreachable, protocol-error), then the API's own `ok:false` refusal,
 * and only calls `onSuccess` once a genuine `ok:true` body is in hand.
 */
export function fromCallResult<TSuccess>(result: CallResult<ApiEnvelope<TSuccess>>, onSuccess: (body: TSuccess) => Outcome): Outcome {
  if (result.transport === "unreachable") return renderUnreachable(result);
  if (result.transport === "protocol-error") return renderProtocolError(result);
  const body = result.body;
  if (!body.ok) return renderRefusal(body.error);
  return onSuccess(body);
}
