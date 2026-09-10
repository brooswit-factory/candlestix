import { describe, expect, test } from "bun:test";
import { AGENT_ID_PATTERN, isAgentId, mintAgentId } from "../../src/agent-id";

function fixedInputs(msSinceEpoch: number, randomValues: number[]) {
  let i = 0;
  return {
    now: () => new Date(msSinceEpoch),
    random: () => {
      const v = randomValues[i % randomValues.length] as number;
      i += 1;
      return v;
    },
  };
}

describe("mintAgentId", () => {
  test("is deterministic given a fixed clock and randomness source", () => {
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    const a = mintAgentId(fixedInputs(1_726_000_000_000, values));
    const b = mintAgentId(fixedInputs(1_726_000_000_000, values));
    expect(a).toBe(b);
  });

  test("starts with '@' and matches AGENT_ID_PATTERN", () => {
    const id = mintAgentId(fixedInputs(Date.now(), [0, 0.5, 0.99]));
    expect(id.startsWith("@")).toBe(true);
    expect(isAgentId(id)).toBe(true);
    expect(AGENT_ID_PATTERN.test(id)).toBe(true);
  });

  test("different clock ticks or randomness produce different ids", () => {
    const a = mintAgentId(fixedInputs(1_000, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    const b = mintAgentId(fixedInputs(2_000, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    const c = mintAgentId(fixedInputs(1_000, [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  // Regression test for the bug a review caught: an earlier version of
  // this module asked for "an integer digit in [0, 32)", a contract
  // `Math.random` (a [0,1) float) silently violates — `Math.floor` of any
  // [0,1) value is always 0, so the entire random part collapsed to zeros
  // and two ids minted in the same millisecond were byte-identical. The
  // contract is now exactly what `Math.random` provides, so passing it
  // straight through must produce non-colliding ids.
  test("Math.random is a correct source by construction: two mints in the same millisecond do not collide", () => {
    const fixedNow = () => new Date(1_726_000_000_000);
    const a = mintAgentId({ now: fixedNow, random: Math.random });
    const b = mintAgentId({ now: fixedNow, random: Math.random });
    expect(a).not.toBe(b);
    expect(isAgentId(a)).toBe(true);
    expect(isAgentId(b)).toBe(true);
  });

  test("clamps a non-conforming randomness source (outside [0,1), including stray integers) rather than producing an invalid id", () => {
    const id = mintAgentId(fixedInputs(1_726_000_000_000, [32, -1, 999, 1.5, -0.3, 0.9999999]));
    expect(isAgentId(id)).toBe(true);
  });

  test("clamps a non-finite randomness source (NaN, +Infinity, -Infinity) rather than corrupting the id with a literal 'undefined'", () => {
    const id = mintAgentId(fixedInputs(1_726_000_000_000, [NaN, Infinity, -Infinity]));
    expect(isAgentId(id)).toBe(true);
    expect(id).not.toContain("undefined");
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
    const id = mintAgentId({ now: () => new Date(0), random: () => 0 });
    expect(id).toBe("@0000000000" + "0".repeat(8));
    expect(isAgentId(id)).toBe(true);
  });
});
