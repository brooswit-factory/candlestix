import { describe, expect, test } from "bun:test";
import { AGENT_ID_PATTERN, isAgentId, mintAgentId } from "../../src/agent-id";

function fixedInputs(msSinceEpoch: number, digits: number[]) {
  let i = 0;
  return {
    now: () => new Date(msSinceEpoch),
    randomBase32Digit: () => {
      const d = digits[i % digits.length] as number;
      i += 1;
      return d;
    },
  };
}

describe("mintAgentId", () => {
  test("is deterministic given a fixed clock and randomness source", () => {
    const inputs = fixedInputs(1_726_000_000_000, [0, 1, 2, 3, 4, 5, 6, 7]);
    const a = mintAgentId(inputs);
    const b = mintAgentId(fixedInputs(1_726_000_000_000, [0, 1, 2, 3, 4, 5, 6, 7]));
    expect(a).toBe(b);
  });

  test("starts with '@' and matches AGENT_ID_PATTERN", () => {
    const id = mintAgentId(fixedInputs(Date.now(), [0, 1, 2]));
    expect(id.startsWith("@")).toBe(true);
    expect(isAgentId(id)).toBe(true);
    expect(AGENT_ID_PATTERN.test(id)).toBe(true);
  });

  test("different clock ticks or randomness produce different ids", () => {
    const a = mintAgentId(fixedInputs(1_000, [1, 2, 3, 4, 5, 6, 7, 8]));
    const b = mintAgentId(fixedInputs(2_000, [1, 2, 3, 4, 5, 6, 7, 8]));
    const c = mintAgentId(fixedInputs(1_000, [8, 7, 6, 5, 4, 3, 2, 1]));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("handles a randomness source that returns values outside [0,32) without producing an invalid id", () => {
    const id = mintAgentId(fixedInputs(1_726_000_000_000, [32, -1, 999, 5.9]));
    expect(isAgentId(id)).toBe(true);
  });
});

describe("isAgentId", () => {
  test("rejects things that are not id-shaped", () => {
    expect(isAgentId("")).toBe(false);
    expect(isAgentId("release-notes")).toBe(false);
    expect(isAgentId("@too-short")).toBe(false);
    expect(isAgentId("no-at-prefix0123456789abcdefgh")).toBe(false);
    expect(isAgentId("@0123456789ABCDEFGH")).toBe(false); // uppercase not in alphabet
  });

  test("accepts a hand-checked well-formed id", () => {
    const id = mintAgentId({ now: () => new Date(0), randomBase32Digit: () => 0 });
    expect(id).toBe("@0000000000" + "0".repeat(8));
    expect(isAgentId(id)).toBe(true);
  });
});
