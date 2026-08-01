import "dotenv/config";
import { loadConfig } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { StreamController } from "./stream-controller.js";

async function main(): Promise<void> {
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
