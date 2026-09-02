import { log } from "./log";

function main(): void {
  log("info", "candlestix starting");
  log("info", "no roster loaded yet");

  // setInterval holds the event loop open; a bare signal listener does not.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = (signal: NodeJS.Signals): void => {
    log("info", `received ${signal}, shutting down`);
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
