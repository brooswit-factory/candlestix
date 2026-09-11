import { describe, expect, test } from "bun:test";
import { EXIT_DAEMON_UNREACHABLE, EXIT_REFUSAL, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "../../../src/cli/exit-codes";
import { fromCallResult, renderProtocolError, renderRefusal, renderUnreachable, usageErrorOutcome } from "../../../src/cli/render";

describe("renderRefusal — R8: the API's message, verbatim, never our own wording", () => {
  test("prints error.message verbatim and exits with the refusal code", () => {
    const outcome = renderRefusal({ kind: "already-archived", message: "agent is archived; turning an archived agent on is refused" });
    expect(outcome).toEqual({ exitCode: EXIT_REFUSAL, stderr: "agent is archived; turning an archived agent on is refused\n" });
  });

  test("a DIFFERENT message renders as a DIFFERENT string — proves this isn't a hardcoded stub (negative control)", () => {
    const outcome = renderRefusal({ kind: "not-found", message: "no agent matches \"ghost\"" });
    expect(outcome.stderr).toBe('no agent matches "ghost"\n');
    expect(outcome.stderr).not.toBe("agent is archived; turning an archived agent on is refused\n");
  });
});

describe("renderRefusal — the message-less-refusal fallback (a defensive guard, unit-tested per the epic's explicit requirement)", () => {
  test("no message, ordinary (< 500) kind: prints ONE generic line naming the kind, never inventing per-kind wording, and exits the refusal code", () => {
    const outcome = renderRefusal({ kind: "not-found" });
    expect(outcome.exitCode).toBe(EXIT_REFUSAL);
    expect(outcome.stderr).toContain("not-found");
    expect(outcome.stderr).toContain("sent no message");
  });

  test("a DIFFERENT kind with no message produces a DIFFERENT line naming ITS kind (negative control: not a fixed string)", () => {
    const a = renderRefusal({ kind: "already-archived" });
    const b = renderRefusal({ kind: "not-archived" });
    expect(a.stderr).toContain("already-archived");
    expect(b.stderr).toContain("not-archived");
    expect(a.stderr).not.toBe(b.stderr);
  });

  test("no message, daemon-side (>= 500) kind: still names the kind and 'sent no message', but exits the DAEMON-UNREACHABLE code, not the refusal code", () => {
    const outcome = renderRefusal({ kind: "store-malformed" });
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
    expect(outcome.stderr).toContain("store-malformed");
    expect(outcome.stderr).toContain("sent no message");
  });
});

describe("renderRefusal — Part 1c's exit-code ruling: daemon-side (>= 500) kinds exit 3, ordinary refusals exit 1, classified via statusForErrorKind", () => {
  test("an ordinary 4xx-mapped kind (e.g. already-archived) exits the refusal code", () => {
    const outcome = renderRefusal({ kind: "already-archived", message: "agent is archived" });
    expect(outcome.exitCode).toBe(EXIT_REFUSAL);
  });

  test("a 5xx-mapped kind (e.g. spawn-failed) exits the daemon-unreachable code, even though it arrives as an ordinary ok:false refusal, not a transport error", () => {
    const outcome = renderRefusal({ kind: "spawn-failed", message: "starting a session failed: boom" });
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
    expect(outcome.stderr).toBe("starting a session failed: boom\n");
  });

  test("every kind this build's contract maps to >= 500 exits the daemon-unreachable code (sweeps the real table rather than spot-checking one kind)", () => {
    const daemonSideKinds = [
      "store-malformed",
      "store-write-failed",
      "session-lookup-failed",
      "session-cleanup-failed",
      "directory-create-failed",
      "spawn-failed",
      "directory-removal-failed",
      "internal-error",
    ];
    for (const kind of daemonSideKinds) {
      const outcome = renderRefusal({ kind, message: `x-${kind}` });
      expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
    }
  });

  test("THE TRAP, stated before running it: a kind unrecognised by this build's contract (e.g. a newer daemon's) must exit the daemon-unreachable code — 'undefined >= 500' is false in JS, so the naive '>= 500 ? 3 : 1' would send it to exit 1, the ruling's exact opposite. If this fails with EXIT_REFUSAL instead, that trap has been walked into.", () => {
    const outcome = renderRefusal({ kind: "a-kind-no-build-of-this-contract-has-ever-listed", message: "from a hypothetical newer daemon" });
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
  });
});

describe("renderUnreachable", () => {
  test("absent socket file: names the path and says the daemon probably never started", () => {
    const outcome = renderUnreachable({ transport: "unreachable", socketPath: "/tmp/x/candlestix.sock", socketFilePresent: false, detail: "boom" });
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
    expect(outcome.stderr).toContain("/tmp/x/candlestix.sock");
    expect(outcome.stderr).toContain("never been started");
    expect(outcome.stderr).toContain("boom");
  });

  test("present-but-refused socket: says the daemon may have died, leaving the file behind (distinct wording from absent)", () => {
    const outcome = renderUnreachable({ transport: "unreachable", socketPath: "/tmp/x/candlestix.sock", socketFilePresent: true, detail: "boom" });
    expect(outcome.stderr).toContain("died");
    expect(outcome.stderr).not.toContain("never been started");
  });
});

describe("renderProtocolError", () => {
  test("distinct from both an ordinary refusal and daemon-unreachable", () => {
    const outcome = renderProtocolError({ transport: "protocol-error", detail: "not json" });
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
    expect(outcome.stderr).toContain("not json");
  });
});

describe("usageErrorOutcome", () => {
  test("exits with the usage-error code and names the message", () => {
    const outcome = usageErrorOutcome("unknown verb \"frobnicate\"");
    expect(outcome).toEqual({ exitCode: EXIT_USAGE_ERROR, stderr: 'candlestix: usage error: unknown verb "frobnicate"\n' });
  });
});

describe("fromCallResult — R6: no-change renders distinctly from both a real change and a refusal", () => {
  test("unreachable short-circuits to renderUnreachable, never calling onSuccess", () => {
    let called = false;
    const outcome = fromCallResult(
      { transport: "unreachable", socketPath: "/x", socketFilePresent: false, detail: "d" },
      () => {
        called = true;
        return { exitCode: EXIT_SUCCESS };
      }
    );
    expect(called).toBe(false);
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
  });

  test("protocol-error short-circuits, never calling onSuccess", () => {
    let called = false;
    const outcome = fromCallResult({ transport: "protocol-error", detail: "d" }, () => {
      called = true;
      return { exitCode: EXIT_SUCCESS };
    });
    expect(called).toBe(false);
    expect(outcome.exitCode).toBe(EXIT_DAEMON_UNREACHABLE);
  });

  test("ok:false routes to renderRefusal, never calling onSuccess", () => {
    let called = false;
    const outcome = fromCallResult(
      { transport: "ok", status: 409, body: { ok: false, error: { kind: "already-archived", message: "no" } } },
      () => {
        called = true;
        return { exitCode: EXIT_SUCCESS };
      }
    );
    expect(called).toBe(false);
    expect(outcome).toEqual({ exitCode: EXIT_REFUSAL, stderr: "no\n" });
  });

  test("ok:true with outcome.kind 'no-change' and 'turned-off' render DIFFERENTLY from each other and both differ from a refusal", () => {
    const noChange = fromCallResult(
      { transport: "ok", status: 200, body: { ok: true, outcome: { kind: "no-change" } } },
      (body) => ({ exitCode: EXIT_SUCCESS, stdout: body.outcome.kind === "no-change" ? "already off\n" : "turned off\n" })
    );
    const changed = fromCallResult(
      { transport: "ok", status: 200, body: { ok: true, outcome: { kind: "turned-off" } } },
      (body) => ({ exitCode: EXIT_SUCCESS, stdout: body.outcome.kind === "no-change" ? "already off\n" : "turned off\n" })
    );
    expect(noChange).toEqual({ exitCode: EXIT_SUCCESS, stdout: "already off\n" });
    expect(changed).toEqual({ exitCode: EXIT_SUCCESS, stdout: "turned off\n" });
    expect(noChange.stdout).not.toBe(changed.stdout);
    // and both are shaped nothing like a refusal outcome
    expect(noChange.exitCode).not.toBe(EXIT_REFUSAL);
    expect(changed.exitCode).not.toBe(EXIT_REFUSAL);
  });
});
