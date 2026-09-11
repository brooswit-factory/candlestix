import { describe, expect, test } from "bun:test";
import { performAttachHandoff } from "../../../src/cli/attach";

describe("performAttachHandoff — the non-TTY refusal decision", () => {
  test("stdin not a TTY: refused, spawnAttach is NEVER called", async () => {
    let spawned = false;
    const result = await performAttachHandoff("sess1", {
      stdinIsTTY: false,
      stdoutIsTTY: true,
      spawnAttach: async () => {
        spawned = true;
        return 0;
      },
    });
    expect(result.kind).toBe("refused-non-tty");
    expect(spawned).toBe(false);
  });

  test("stdout not a TTY: also refused, spawnAttach is NEVER called", async () => {
    let spawned = false;
    const result = await performAttachHandoff("sess1", {
      stdinIsTTY: true,
      stdoutIsTTY: false,
      spawnAttach: async () => {
        spawned = true;
        return 0;
      },
    });
    expect(result.kind).toBe("refused-non-tty");
    expect(spawned).toBe(false);
  });

  test("both a TTY: hands off, and the RESULT is exactly the child's exit code — including a non-zero one", async () => {
    const result = await performAttachHandoff("sess1", {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      spawnAttach: async () => 47,
    });
    expect(result).toEqual({ kind: "handed-off", exitCode: 47 });
  });

  test("negative control: a DIFFERENT child exit code produces a DIFFERENT result — proves this isn't a hardcoded 0", async () => {
    const a = await performAttachHandoff("sess1", { stdinIsTTY: true, stdoutIsTTY: true, spawnAttach: async () => 0 });
    const b = await performAttachHandoff("sess1", { stdinIsTTY: true, stdoutIsTTY: true, spawnAttach: async () => 130 });
    expect(a.kind === "handed-off" && a.exitCode).toBe(0);
    expect(b.kind === "handed-off" && b.exitCode).toBe(130);
  });

  test("the exact session short id is passed through to spawnAttach untouched", async () => {
    let receivedId: string | undefined;
    await performAttachHandoff("the-exact-id-123", {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      spawnAttach: async (id) => {
        receivedId = id;
        return 0;
      },
    });
    expect(receivedId).toBe("the-exact-id-123");
  });
});
