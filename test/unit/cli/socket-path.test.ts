// The socket-path defect (CNDLX-31): CNDLX-30's deleted, provisional
// src/api-contract.ts built its OWN socket path — its own XDG inputs plus
// a guessed filename (`candlestix.sock`) — while the real daemon binds
// `apiSocketPath()` from src/paths.ts (`.../api.sock`, see src/index.ts).
// Two independent derivations of a path that must have exactly one; the
// CLI would report "the daemon is not running" while it is.
//
// A test asserting the two paths are EQUAL STRINGS would not have caught
// the regression this guards against were it to recur: two derivations
// can produce equal strings today and drift apart later (e.g. one of them
// forgets a corner of `currentXdgInputs()`, as the deleted module did with
// its own private copy). The only test that cannot silently regress is one
// that asserts the CLI's resolver and the daemon's resolver are the SAME
// FUNCTION — proven here by reference identity (`toBe`), not `toEqual`.

import { describe, expect, test } from "bun:test";
import { apiSocketPath as cliSocketPath } from "../../../src/api/contract";
import { apiSocketPath as daemonSocketPath } from "../../../src/paths";

describe("apiSocketPath — the CLI resolves its socket through the SAME function the daemon binds with", () => {
  test("identity, not equal output: src/api/contract.ts's re-export IS src/paths.ts's own apiSocketPath — the exact binding src/index.ts (the daemon) imports and binds `Bun.serve({unix: ...})` to", () => {
    expect(cliSocketPath).toBe(daemonSocketPath);
  });

  test("negative control, shaped exactly like the historical defect: an independently-derived resolver is NOT the same function, and produces a DIFFERENT path — proving the identity check above is capable of failing, not vacuously true", () => {
    // Mirrors the deleted src/api-contract.ts's own derivation shape (its
    // own XDG inputs, a guessed filename) closely enough to fail the same
    // way it did — reconstructed only to prove this test can fail; never
    // imported by any CLI module.
    function independentlyDerivedSocketPath(): string {
      return daemonSocketPath().replace(/\/api\.sock$/, "/candlestix.sock");
    }
    expect(independentlyDerivedSocketPath).not.toBe(daemonSocketPath);
    expect(independentlyDerivedSocketPath()).not.toBe(daemonSocketPath());

    // And a merely-equal-looking impostor function — proving `toBe` above
    // is doing real work (reference identity), not something `toEqual` on
    // the return value would have caught just as well.
    const impostor = () => daemonSocketPath();
    expect(impostor).not.toBe(daemonSocketPath);
    expect(impostor()).toBe(daemonSocketPath()); // equal output; still not the same function
  });
});
