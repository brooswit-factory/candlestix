import { describe, expect, test } from "bun:test";
import { AGENT_NAME_MAX_LENGTH, validateAgentNameSyntax } from "../../src/agent";

describe("validateAgentNameSyntax", () => {
  test("accepts names matching the roster precedent's character set", () => {
    for (const name of ["a", "0", "release-notes", "a.b_c-9", "9lives", "z".repeat(AGENT_NAME_MAX_LENGTH)]) {
      expect(validateAgentNameSyntax(name)).toEqual({ ok: true });
    }
  });

  test("rejects empty names", () => {
    const result = validateAgentNameSyntax("");
    expect(result.ok).toBe(false);
  });

  test("rejects names longer than AGENT_NAME_MAX_LENGTH", () => {
    const result = validateAgentNameSyntax("a".repeat(AGENT_NAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  test("rejects uppercase, spaces, and characters outside the allowed set", () => {
    for (const name of ["Release-Notes", "release notes", "release/notes", "release@notes", "_leading-underscore"]) {
      expect(validateAgentNameSyntax(name).ok).toBe(false);
    }
  });

  test("rejects a name starting with '.', '_' or '-' (must start with a letter or digit, per the roster precedent)", () => {
    for (const name of [".hidden", "_x", "-x"]) {
      expect(validateAgentNameSyntax(name).ok).toBe(false);
    }
  });

  test("no valid name ever contains '@' — the char the id encoding relies on for R1 (see agent-name-id-disjoint.test.ts for the full proof)", () => {
    expect(validateAgentNameSyntax("@whatever").ok).toBe(false);
  });
});
