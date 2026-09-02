export type LogLevel = "info" | "warn" | "error";

// Pure on purpose: kept free of console access so it can be asserted on directly.
export function formatLogLine(level: LogLevel, message: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${level.toUpperCase()} ${message}`;
}

export function log(level: LogLevel, message: string): void {
  console.log(formatLogLine(level, message));
}
