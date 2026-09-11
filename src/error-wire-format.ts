// CNDLX-27 section 2a: R8 says every refusal carries a message a surface
// shows verbatim, and surfaces never invent a second vocabulary of error
// wording. At CNDLX-27's read of f261c9b, nine variants that can reach the
// wire did NOT yet have one — fixed at each construction site in
// agent-resolver.ts and agent-actions.ts. This module is the evidence the
// epic explicitly ruled it wants: not spot checks, but a check that
// ENUMERATES every error kind reachable from any action's result union,
// built so a TENTH variant added later without a `message` fails it.
//
// How "fails it" is actually enforced, in two independent layers:
//
//   1. COMPILE TIME (bun run typecheck): `ALL_WIRE_ERROR_KINDS` below is
//      type-checked against `AnyActionError["kind"]` by `checkExhaustive`
//      — if a new error variant is added to ANY of the unions this module
//      imports and its `kind` is not added to that array, the array
//      literal fails to typecheck, naming the missing kind in the error.
//      This catches a new variant regardless of whether it has a
//      `message` field.
//   2. RUNTIME (bun test, test/unit/error-wire-format.test.ts): the test
//      iterates `ALL_WIRE_ERROR_KINDS` (never a hand-written list of its
//      own) and asserts `hasServerMessage` is true for a minimal fixture
//      of each — so a new kind that DOES get added to the array, but
//      whose real construction site forgets to set `message`, is still
//      required to carry one to pass this test. A negative-control
//      fixture (a kind with no `message`) proves the check can actually
//      fail, not just always pass.
//
// Together these mean a tenth variant cannot silently escape either the
// "did anyone add it here" check (compile time) or the "does it actually
// have a message" check (runtime) — which is the exact failure shape
// CNDLX-27's doc warns a hand-written nine-assertion test would have.

import type {
  ArchiveAgentError,
  CreateAgentError,
  DeleteAgentError,
  OffAgentError,
  OnAgentError,
  RenameAgentError,
  UnarchiveAgentError,
} from "./agent-actions";
import type { AttachTargetError } from "./attach-target";
import type { OpenTerminalError } from "./open-terminal";

/**
 * Every error kind reachable at the wire, across every route this task
 * ships (section 2's whole table) — a strict superset of CNDLX-27's
 * nine-variant list, since R8's own wording ("every refusal") is not
 * scoped to only the pre-existing gap; attach-target's and open-terminal's
 * own refusals (new in this PR) are held to the identical standard from
 * the start rather than needing a follow-up ticket to notice them later.
 */
export type AnyActionError =
  | CreateAgentError
  | OnAgentError
  | OffAgentError
  | ArchiveAgentError
  | UnarchiveAgentError
  | RenameAgentError
  | DeleteAgentError
  | AttachTargetError
  | OpenTerminalError;

type Kind = AnyActionError["kind"];

/**
 * Standard "exhaustive array of a union" idiom: `Exclude<Kind, T[number]>`
 * computes which kind literals are missing from `arr`; if that is
 * non-empty, the parameter type becomes incompatible with `T` and
 * TypeScript reports the missing kind(s) directly in the error message.
 * This is what makes `ALL_WIRE_ERROR_KINDS` below fail to typecheck the
 * moment a new `kind` exists on `AnyActionError` but is not listed.
 */
function checkExhaustive<T extends readonly Kind[]>(arr: T & ([Exclude<Kind, T[number]>] extends [never] ? unknown : never)): T {
  return arr;
}

export const ALL_WIRE_ERROR_KINDS = checkExhaustive([
  "store-malformed",
  "invalid-name",
  "reserved-name",
  "name-taken",
  "directory-create-failed",
  "spawn-failed",
  "store-write-failed",
  "not-found",
  "ambiguous",
  "already-archived",
  "archived",
  "session-lookup-failed",
  "session-cleanup-failed",
  "not-archived",
  "directory-removal-failed",
  "off",
  "no-live-session",
  "multiple-live-sessions",
  "not-implemented",
] as const);

function assertNever(x: never): never {
  throw new Error(`error-wire-format: unreachable — an error kind reached hasServerMessage without a case: ${JSON.stringify(x)}`);
}

/**
 * The actual per-kind exhaustiveness check, independent of the array
 * above: a `switch` over every case in `Kind`, with a `default:
 * assertNever(err)` branch that only compiles if every member of `Kind`
 * was handled by an earlier `case`. Adding a new error variant anywhere in
 * `AnyActionError` without adding its `kind` here fails `bun run
 * typecheck` a second, independent way from `ALL_WIRE_ERROR_KINDS` above.
 */
export function hasServerMessage(err: AnyActionError): boolean {
  switch (err.kind) {
    case "store-malformed":
    case "invalid-name":
    case "reserved-name":
    case "name-taken":
    case "directory-create-failed":
    case "spawn-failed":
    case "store-write-failed":
    case "not-found":
    case "ambiguous":
    case "already-archived":
    case "archived":
    case "session-lookup-failed":
    case "session-cleanup-failed":
    case "not-archived":
    case "directory-removal-failed":
    case "off":
    case "no-live-session":
    case "multiple-live-sessions":
    case "not-implemented":
      return typeof err.message === "string" && err.message.length > 0;
    default:
      return assertNever(err);
  }
}
