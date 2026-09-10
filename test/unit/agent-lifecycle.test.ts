import { describe, expect, test } from "bun:test";
import {
  RESERVED_AGENT_NAMES,
  checkAgentNameAllowed,
  decideArchive,
  decideDelete,
  decideOff,
  decideOn,
  decideUnarchive,
} from "../../src/agent-lifecycle";
import type { AgentLifecycleState } from "../../src/agent";

const ALL_STATES: AgentLifecycleState[] = ["on", "off", "archived"];

describe("decideOn — S4's `on` column", () => {
  test("on -> no-change", () => {
    expect(decideOn("on")).toEqual({ kind: "no-change" });
  });
  test("off -> transition to on, starts a session", () => {
    expect(decideOn("off")).toEqual({ kind: "transition", to: "on", effect: "start-session" });
  });
  test("archived -> REFUSED, not silently unarchived", () => {
    const result = decideOn("archived");
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.code).toBe("already-archived");
      expect(result.message).toContain("unarchive");
    }
  });
});

describe("decideOff — S4's `off` column", () => {
  test("on -> transition to off, stops the session", () => {
    expect(decideOff("on")).toEqual({ kind: "transition", to: "off", effect: "stop-session" });
  });
  test("off -> no-change", () => {
    expect(decideOff("off")).toEqual({ kind: "no-change" });
  });
  test("archived -> REFUSED, names unarchive", () => {
    const result = decideOff("archived");
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.message).toContain("unarchive");
    }
  });
});

describe("decideArchive — S4's `archive` column", () => {
  test("on -> transition to archived, stops the session", () => {
    expect(decideArchive("on")).toEqual({ kind: "transition", to: "archived", effect: "stop-session" });
  });
  test("off -> transition to archived, no session to stop", () => {
    expect(decideArchive("off")).toEqual({ kind: "transition", to: "archived", effect: "none" });
  });
  test("archived -> REFUSED, already archived", () => {
    expect(decideArchive("archived")).toEqual({ kind: "refused", code: "already-archived", message: "agent is already archived" });
  });
});

describe("decideUnarchive — S4's `unarchive` column: never lands on `on`", () => {
  test("archived -> transition to OFF (never on)", () => {
    expect(decideUnarchive("archived")).toEqual({ kind: "transition", to: "off", effect: "none" });
  });
  test("on -> REFUSED, not archived", () => {
    const result = decideUnarchive("on");
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.code).toBe("not-archived");
  });
  test("off -> REFUSED, not archived", () => {
    const result = decideUnarchive("off");
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.code).toBe("not-archived");
  });
});

describe("decideDelete — S4's `delete` column: legal unconditionally", () => {
  for (const state of ALL_STATES) {
    test(`${state} -> transition, always attempts to stop a live session first`, () => {
      expect(decideDelete(state)).toEqual({ kind: "transition", effect: "stop-session" });
    });
  }
});

describe("exhaustiveness — every (verb, state) pair from S4 is covered", () => {
  test("decideOn/decideOff/decideArchive/decideUnarchive/decideDelete each handle all three states without throwing", () => {
    for (const state of ALL_STATES) {
      expect(() => decideOn(state)).not.toThrow();
      expect(() => decideOff(state)).not.toThrow();
      expect(() => decideArchive(state)).not.toThrow();
      expect(() => decideUnarchive(state)).not.toThrow();
      expect(() => decideDelete(state)).not.toThrow();
    }
  });
});

describe("checkAgentNameAllowed — R17 layered on validateAgentNameSyntax, not forked from it", () => {
  test("a normal, non-reserved name is allowed", () => {
    expect(checkAgentNameAllowed("release-notes")).toEqual({ ok: true });
  });

  test("invalid syntax is refused as invalid-syntax, not reserved", () => {
    const result = checkAgentNameAllowed("Not_Valid!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-syntax");
  });

  test("every reserved word is refused, naming the word and saying it is reserved", () => {
    for (const word of RESERVED_AGENT_NAMES) {
      const result = checkAgentNameAllowed(word);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("reserved");
        if (result.error.kind === "reserved") {
          expect(result.error.word).toBe(word);
          expect(result.error.message).toContain(word);
          expect(result.error.message).toContain("reserved");
        }
      }
    }
  });

  test("the reserved list is exactly the whole action-set vocabulary (R17's superset ruling)", () => {
    expect(new Set(RESERVED_AGENT_NAMES)).toEqual(
      new Set(["create", "attach", "on", "off", "rename", "name", "archive", "unarchive", "delete", "list"])
    );
  });

  test("a reserved word that also fails syntax (e.g. would need uppercase) is still just invalid-syntax — reserved-ness is checked only after syntax passes", () => {
    // All reserved words are lowercase and syntactically valid today, so
    // this documents the ordering rather than exercising a real conflict:
    // checkAgentNameAllowed short-circuits on invalid syntax before ever
    // consulting RESERVED_AGENT_NAMES.
    const result = checkAgentNameAllowed("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-syntax");
  });
});
