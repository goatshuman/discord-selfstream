import "dotenv/config";
import http from "http";
import { loadConfig } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { StreamController } from "./stream-controller.js";

async function main(): Promise<void> {
  // 1. Start a basic HTTP server for Render's health checks and keep-alive pinging
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Discord Selfstream is online!");
  }).listen(port, () => {
    logger.info(`HTTP keep-alive server listening on port ${port}`);
  });

  // 2. Start your Discord stream controller
  const config = await loadConfig();
  const controller = new StreamController(config);

  process.once("SIGINT", () => controller.stop("SIGINT"));
  process.once("SIGTERM", () => controller.stop("SIGTERM"));

  await controller.run();
}

main().catch((error) => {
  logger.error("Fatal startup error", errorFields(error));
  process.exitCode = 1;
});
