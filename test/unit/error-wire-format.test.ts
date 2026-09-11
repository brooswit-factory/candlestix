import { describe, expect, test } from "bun:test";
import { ALL_WIRE_ERROR_KINDS, hasServerMessage, type AnyActionError } from "../../src/error-wire-format";

/**
 * A minimal fixture per kind — just enough shape for `hasServerMessage`'s
 * `switch` to narrow on `.kind` and read `.message`; the other structured
 * fields each real variant carries (`query`, `matches`, `failed`, `holder`,
 * `word`, `error`, `reason`, `sessions`, `epic`) are irrelevant to THIS
 * check and are deliberately omitted here, so this file does not have to
 * track every union member's full shape a second time — that duplication
 * is exactly what `agent-actions.test.ts` etc. already cover per-action.
 */
function fixtureWithMessage(kind: (typeof ALL_WIRE_ERROR_KINDS)[number]): AnyActionError {
  return { kind, message: `a real message for "${kind}"` } as unknown as AnyActionError;
}

function fixtureWithoutMessage(kind: (typeof ALL_WIRE_ERROR_KINDS)[number]): AnyActionError {
  return { kind } as unknown as AnyActionError;
}

describe("hasServerMessage — R8's message gap, enumerated rather than spot-checked", () => {
  test("every currently-known wire error kind reports true when it carries a message", () => {
    for (const kind of ALL_WIRE_ERROR_KINDS) {
      expect(hasServerMessage(fixtureWithMessage(kind))).toBe(true);
    }
  });

  test("negative control: every kind reports FALSE when its message is missing — proves the check can actually fail, not just always pass", () => {
    for (const kind of ALL_WIRE_ERROR_KINDS) {
      expect(hasServerMessage(fixtureWithoutMessage(kind))).toBe(false);
    }
  });

  test("negative control: an empty-string message is also treated as absent", () => {
    for (const kind of ALL_WIRE_ERROR_KINDS) {
      expect(hasServerMessage({ kind, message: "" } as unknown as AnyActionError)).toBe(false);
    }
  });

  test("ALL_WIRE_ERROR_KINDS covers every kind this suite's own error unions can produce (compile-time exhaustiveness, exercised at runtime)", () => {
    // ALL_WIRE_ERROR_KINDS is built with `checkExhaustive` in
    // error-wire-format.ts, which fails `bun run typecheck` on its own if
    // a kind is missing — this assertion is a runtime witness that the
    // array is non-trivial (catches "someone hollowed the array out to
    // `[]` to dodge the compiler", which `checkExhaustive` alone would NOT
    // catch, since `[]` still typechecks against `Exclude<Kind, never>`
    // only when `Kind` is also `never`, which it is not).
    expect(ALL_WIRE_ERROR_KINDS.length).toBeGreaterThanOrEqual(19);
    expect(new Set(ALL_WIRE_ERROR_KINDS).size).toBe(ALL_WIRE_ERROR_KINDS.length); // no duplicates
  });

  test("originally-named nine variants (CNDLX-27 section 2a) are all present", () => {
    const original = [
      "not-found",
      "ambiguous",
      "store-malformed",
      "store-write-failed",
      "session-lookup-failed",
      "session-cleanup-failed",
      "directory-create-failed",
      "spawn-failed",
      "directory-removal-failed",
    ];
    for (const kind of original) {
      expect(ALL_WIRE_ERROR_KINDS).toContain(kind as (typeof ALL_WIRE_ERROR_KINDS)[number]);
    }
  });
});
