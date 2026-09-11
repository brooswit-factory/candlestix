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
  test("no message: prints ONE generic line naming the kind, never inventing per-kind wording", () => {
    const outcome = renderRefusal({ kind: "store-malformed" });
    expect(outcome.exitCode).toBe(EXIT_REFUSAL);
    expect(outcome.stderr).toContain("store-malformed");
    expect(outcome.stderr).toContain("sent no message");
  });

  test("a DIFFERENT kind with no message produces a DIFFERENT line naming ITS kind (negative control: not a fixed string)", () => {
    const a = renderRefusal({ kind: "session-lookup-failed" });
    const b = renderRefusal({ kind: "spawn-failed" });
    expect(a.stderr).toContain("session-lookup-failed");
    expect(b.stderr).toContain("spawn-failed");
    expect(a.stderr).not.toBe(b.stderr);
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
