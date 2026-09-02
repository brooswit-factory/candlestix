import { describe, expect, test } from "bun:test";
import { formatLogLine } from "../../src/log";

describe("formatLogLine", () => {
  const at = new Date("2020-01-15T03:04:05.006Z");

  test("uppercases the level and embeds the ISO timestamp and message", () => {
    expect(formatLogLine("info", "candlestix starting", at)).toBe(
      "[2020-01-15T03:04:05.006Z] INFO candlestix starting"
    );
  });

  test("uppercases warn and error the same way", () => {
    expect(formatLogLine("warn", "retrying", at)).toBe("[2020-01-15T03:04:05.006Z] WARN retrying");
    expect(formatLogLine("error", "gave up", at)).toBe("[2020-01-15T03:04:05.006Z] ERROR gave up");
  });
});
