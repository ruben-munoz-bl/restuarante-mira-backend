require("dotenv").config();

const cron = require("node-cron");
const { env } = require("./config/env");
const app = require("./app");
const { logger } = require("./middlewares/errorHandler");

async function runCron(name, fn) {
  try {
    await fn();
  } catch (err) {
    logger.error({ cron: name, error: err.message, stack: err.stack }, "Cron job failed");
  }
}

cron.schedule("*/15 * * * *", () => runCron("autoComplete", () => require("./modules/cron/autoComplete").autoCompletarReservas()), {
  timezone: "UTC",
});

cron.schedule("0 1 * * 1", () => runCron("streaks", () => require("./modules/cron/streaks").actualizarRachasReservas()), {
  timezone: "UTC",
});

cron.schedule("0 2 * * *", () => runCron("promotions", () => require("./modules/cron/promotions").estadisticasPromociones()), {
  timezone: "UTC",
});

const port = env.PORT;
const server = app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, "MIRA API listening");
});

function shutdown(signal) {
  logger.info({ signal }, "Shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
