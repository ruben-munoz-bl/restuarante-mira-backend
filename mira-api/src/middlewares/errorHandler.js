const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

function errorHandler(err, req, res, _next) {
  const requestId = req.headers["x-request-id"] || "unknown";
  logger.error({ requestId, error: err.message, stack: err.stack }, "Unhandled error");
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || "INTERNAL_ERROR",
    message: process.env.NODE_ENV === "production" ? "Error interno" : err.message,
    requestId,
  });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requestId(req, res, next) {
  req.id = req.headers["x-request-id"] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader("X-Request-Id", req.id);
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - start, requestId: req.id });
  });
  next();
}

module.exports = { logger, errorHandler, asyncHandler, requestId, requestLogger };
