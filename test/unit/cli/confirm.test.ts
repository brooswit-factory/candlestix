import { describe, expect, test } from "bun:test";
import { resolveDeleteConfirmation } from "../../../src/cli/confirm";

describe("resolveDeleteConfirmation — the full 5-case matrix", () => {
  test("TTY, explicit affirmative 'yes' -> proceed", async () => {
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      { stdinIsTTY: true, promptAndReadLine: async () => "yes" }
    );
    expect(result).toEqual({ kind: "proceed" });
  });

  test("TTY, explicit affirmative 'y' (short form) -> proceed", async () => {
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      { stdinIsTTY: true, promptAndReadLine: async () => "y" }
    );
    expect(result).toEqual({ kind: "proceed" });
  });

  test("TTY, affirmative is case-insensitive and trims whitespace", async () => {
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      { stdinIsTTY: true, promptAndReadLine: async () => "  YES  " }
    );
    expect(result).toEqual({ kind: "proceed" });
  });

  test("TTY, declined with an explicit 'no' -> declined", async () => {
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      { stdinIsTTY: true, promptAndReadLine: async () => "no" }
    );
    expect(result).toEqual({ kind: "declined" });
  });

  test("TTY, a bare Enter (empty line) is declined, NOT an affirmative", async () => {
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      { stdinIsTTY: true, promptAndReadLine: async () => "" }
    );
    expect(result).toEqual({ kind: "declined" });
  });

  test("--yes short-circuits on a TTY: proceeds WITHOUT ever prompting", async () => {
    let prompted = false;
    const result = await resolveDeleteConfirmation(
      { yes: true, agentDescription: "@abc" },
      {
        stdinIsTTY: true,
        promptAndReadLine: async () => {
          prompted = true;
          return "irrelevant";
        },
      }
    );
    expect(result).toEqual({ kind: "proceed" });
    expect(prompted).toBe(false);
  });

  test("--yes short-circuits on a non-TTY too: proceeds without ever needing input", async () => {
    let prompted = false;
    const result = await resolveDeleteConfirmation(
      { yes: true, agentDescription: "@abc" },
      {
        stdinIsTTY: false,
        promptAndReadLine: async () => {
          prompted = true;
          return "irrelevant";
        },
      }
    );
    expect(result).toEqual({ kind: "proceed" });
    expect(prompted).toBe(false);
  });

  test("non-TTY, no --yes: refused outright, message says to pass --yes, and the prompt is NEVER called (it would hang)", async () => {
    let prompted = false;
    const result = await resolveDeleteConfirmation(
      { yes: false, agentDescription: "@abc" },
      {
        stdinIsTTY: false,
        promptAndReadLine: async () => {
          prompted = true;
          return "yes";
        },
      }
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.message).toContain("--yes");
      expect(result.message).toContain("@abc");
    }
    expect(prompted).toBe(false);
  });

  test("the prompt text names which agent is being deleted", async () => {
    let seenPrompt = "";
    await resolveDeleteConfirmation(
      { yes: false, agentDescription: '@xyz (name: "doomed")' },
      {
        stdinIsTTY: true,
        promptAndReadLine: async (promptText) => {
          seenPrompt = promptText;
          return "yes";
        },
      }
    );
    expect(seenPrompt).toContain('@xyz (name: "doomed")');
  });
});
