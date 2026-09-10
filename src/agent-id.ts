// Id minting for agent records (CNDLX-22 / CNDLX-17). Pure: clock and
// randomness are parameters, never read ambiently, per this tree's
// existing convention (see log.ts, staleness.ts, xdg.ts).
//
// R1 (disjoint id/name spaces by construction): every minted id starts
// with "@", a character the agent name grammar (see agent.ts,
// AGENT_NAME_PATTERN) can never contain anywhere in the string — not just
// as a leading character. That is a full-string charset exclusion, not a
// "starts with a digit" convention, so it holds regardless of how the name
// grammar's own leading-character class is defined. "@" was picked over
// alternatives considered:
//   - "#" starts a shell comment when it is the first character of an
//     unquoted word — exactly wrong for something "an operator can type...
//     at a shell" (this ticket's own requirement).
//   - a bare leading-digit convention (mirroring the existing roster name
//     pattern's `[a-z0-9]` start) would have required tightening that
//     pattern to letter-only, which the ticket flags as the sharp edge to
//     watch for. Using a char outside the name alphabet entirely sidesteps
//     that tightening altogether.
//   - "@" reads naturally out loud ("at ..."), is shell-safe as a leading
//     character (no quoting surprises the way "#", "*", or "~" would have),
//     and thematically fits "always-on agents" you refer to by handle.

const ID_PREFIX = "@";

// Crockford base32 alphabet (excludes i, l, o, u to avoid visual confusion
// with 1/1/0/v when an operator reads an id aloud or transcribes one by
// hand). 32 symbols, so each represents exactly 5 bits / one base-32 digit.
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// 10 base32 chars of millisecond timestamp (32^10 ~= 1.1e15 ms, ~35,700
// years of range from the epoch — comfortably future-proof) followed by 8
// base32 chars of randomness (32^8 = 2^40, ~1.1e12 combinations per
// millisecond) — the same two-part shape as a ULID, sized down slightly
// since global cross-process sortability was not asked for here, only
// "durable, typeable, and disjoint from names."
const TIMESTAMP_CHARS = 10;
const RANDOM_CHARS = 8;
const ID_BODY_CHARS = TIMESTAMP_CHARS + RANDOM_CHARS;

export const AGENT_ID_PATTERN = new RegExp(`^@[${ID_ALPHABET}]{${ID_BODY_CHARS}}$`);

/** Structural check only — does not consult any store. True iff `value` has the shape a minted id would have. */
export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

function encodeBase32Fixed(value: number, length: number): string {
  // Plain division/modulo, not bitwise ops: bitwise operators in JS coerce
  // to 32-bit signed integers, which silently corrupts a millisecond
  // timestamp (well above 2^31) long before it corrupts a small random
  // value. Division-based encoding is correct for any safe integer.
  let remaining = value;
  const chars = new Array<string>(length);
  for (let i = length - 1; i >= 0; i--) {
    const alphabetChar = ID_ALPHABET[remaining % 32];
    chars[i] = alphabetChar as string;
    remaining = Math.floor(remaining / 32);
  }
  return chars.join("");
}

export interface MintAgentIdInputs {
  /** Injected clock — see this tree's clock-as-parameter convention. */
  now: () => Date;
  /** Injected randomness source: must return an integer in [0, 32). */
  randomBase32Digit: () => number;
}

/** Mints a fresh, durable agent id. Pure given its inputs — deterministic under test with a fixed clock/randomness. */
export function mintAgentId(inputs: MintAgentIdInputs): string {
  const timestampMs = inputs.now().getTime();
  const timestampPart = encodeBase32Fixed(Math.max(0, timestampMs), TIMESTAMP_CHARS);
  let randomPart = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    const digit = Math.floor(inputs.randomBase32Digit()) % 32;
    randomPart += ID_ALPHABET[((digit % 32) + 32) % 32];
  }
  return `${ID_PREFIX}${timestampPart}${randomPart}`;
}
