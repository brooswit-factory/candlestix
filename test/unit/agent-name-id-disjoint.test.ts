// R1 proof: id-space and name-space must be disjoint by construction. This
// file exists specifically because the ticket calls out that a
// hand-written single-example test "does not demonstrate" disjointness —
// it would pass even if the shapes overlapped everywhere else. What
// follows instead:
//   1. Mints many ids (1000) through the REAL minter, with injected
//      randomness/clock so the run is still deterministic, and asserts
//      EVERY one is rejected by the name validator.
//   2. Takes a large, varied corpus of names the name validator accepts
//      (randomly generated within the grammar, plus hand-picked edge
//      cases) and asserts NONE of them is accepted as an id.
//
// Why this can be asserted as a single structural fact instead of an
// exhaustive search: AGENT_NAME_PATTERN's character class
// (`[a-z0-9._-]`) never includes "@" at any position, and every minted id
// (agent-id.ts) starts with "@". The tests below still run the full
// property check rather than relying on that comment.

import { describe, expect, test } from "bun:test";
import { isAgentId, mintAgentId } from "../../src/agent-id";
import { validateAgentNameSyntax, AGENT_NAME_MAX_LENGTH } from "../../src/agent";

// Deterministic PRNG (mulberry32) so the "many ids" run is reproducible
// across CI runs while still being an injected — not ambient — source of
// randomness, per this tree's clock/randomness-as-parameter convention.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789._-";

function randomValidName(random: () => number): string {
  const length = 1 + Math.floor(random() * AGENT_NAME_MAX_LENGTH);
  const firstAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let name = firstAlphabet[Math.floor(random() * firstAlphabet.length)] as string;
  while (name.length < length) {
    name += NAME_ALPHABET[Math.floor(random() * NAME_ALPHABET.length)] as string;
  }
  return name;
}

describe("R1: id-space and name-space are disjoint", () => {
  test("every one of 1000 ids minted through the real minter is rejected by the name validator", () => {
    const rand = mulberry32(1337);
    const clockBase = 1_726_000_000_000;
    let rejectedCount = 0;
    for (let i = 0; i < 1000; i++) {
      const id = mintAgentId({
        now: () => new Date(clockBase + i),
        randomBase32Digit: () => Math.floor(rand() * 32),
      });
      const result = validateAgentNameSyntax(id);
      if (!result.ok) rejectedCount += 1;
    }
    expect(rejectedCount).toBe(1000);
  });

  test("none of 1000 validator-accepted names is ever accepted as an id-shape", () => {
    const rand = mulberry32(9001);
    const corpus: string[] = [];
    for (let i = 0; i < 1000; i++) {
      corpus.push(randomValidName(rand));
    }
    // Sanity-check the corpus is actually a corpus of ACCEPTED names —
    // otherwise this test would trivially pass by testing nothing.
    for (const name of corpus) {
      expect(validateAgentNameSyntax(name)).toEqual({ ok: true });
    }
    const acceptedAsId = corpus.filter((name) => isAgentId(name));
    expect(acceptedAsId).toEqual([]);
  });

  test("hand-picked edge-case names (boundary lengths, every allowed character) are also rejected as ids", () => {
    const edgeCases = [
      "a",
      "0",
      "z".repeat(AGENT_NAME_MAX_LENGTH),
      "9".repeat(AGENT_NAME_MAX_LENGTH),
      "a.b_c-d0",
      "0-0-0-0",
    ];
    for (const name of edgeCases) {
      expect(validateAgentNameSyntax(name)).toEqual({ ok: true }); // confirm it's really in-grammar
      expect(isAgentId(name)).toBe(false);
    }
  });
});
