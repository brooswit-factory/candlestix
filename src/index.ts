import { log } from "./log";

function main(): void {
  log("info", "candlestix starting");
  log("info", "no roster loaded yet — CNDLX-1 adds it next");

  const shutdown = (signal: NodeJS.Signals): void => {
    log("info", `received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
