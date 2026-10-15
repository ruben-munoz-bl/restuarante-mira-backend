const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { requestId, requestLogger, errorHandler } = require("./middlewares/errorHandler");
const { accessLog } = require("./middlewares/accessLog");
const { middlewareMetricas } = require("./modules/metricas/metricas");

const { rateLimit } = require("./middlewares/rateLimit");
const app = express();

function jsonReplacer(_key, value) {
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (value.constructor && value.constructor.name === "Timestamp" && typeof value.toDate === "function") {
      return value.toDate().toISOString();
    }
    if (value._seconds !== undefined && value._nanoseconds !== undefined) {
      return new Date(value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6)).toISOString();
    }
    if (value.seconds !== undefined && value.nanoseconds !== undefined && typeof value.toDate !== "function") {
      return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6)).toISOString();
    }
  }
  return value;
}

app.set("json replacer", jsonReplacer);
// Render pone un proxy delante: sin esto req.ip es la IP del proxy y todos los
// usuarios compartirían el mismo cupo del rate limit global. 1 = solo el primer salto.
app.set("trust proxy", 1);
app.use(helmet());

const { env } = require("./config/env");
const { crearPoliticaCors } = require("./middlewares/corsOrigins");
const isAllowedOrigin = crearPoliticaCors(env.CORS_ALLOWED_ORIGINS);
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }));

app.use(express.json());
app.use(requestId);
app.use(middlewareMetricas);
app.use(requestLogger);
app.use(accessLog);
// Cupo amplio por IP: en una oficina o una demo muchos usuarios salen por la misma IP.
// Solo frena abusos; ajustable con RATE_LIMIT_GLOBAL sin redeploy de código.
const LIMITE_GLOBAL = Number(process.env.RATE_LIMIT_GLOBAL) || 1200;
app.use("/v1", rateLimit(60000, LIMITE_GLOBAL, (req) => `api:${req.ip}`));

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/v1/reservations", require("./modules/reservations/routes"));
app.use("/v1/points", require("./modules/points/routes"));
app.use("/v1/tickets", require("./modules/tickets/routes"));
app.use("/v1/invite", require("./modules/invitations/routes"));
app.use("/v1/promotions", require("./modules/promotions/routes"));
app.use("/v1/interactions", require("./modules/interactions/routes"));
app.use("/v1/auditoria", require("./modules/auditoria/routes"));
app.use("/v1/metricas", require("./modules/metricas/routes"));
app.use("/v1/espera", require("./modules/espera/routes"));
app.use("/v1/jams", require("./modules/jams/routes"));
app.use("/v1/reviews", require("./modules/reviews/routes"));
app.use("/v1/admin", require("./modules/admin/routes"));
app.use("/v1/dashboard", require("./modules/dashboard/router"));
app.use("/v1/restaurants", require("./modules/restaurants/routes"));
app.use("/v1/negocios", require("./modules/negocios/routes"));
app.use("/v1/users", require("./modules/users/routes"));
app.use("/v1/contactos", require("./modules/contactos/routes"));
app.use("/v1/mensajes", require("./modules/mensajes/routes"));
app.use("/v1/push", require("./modules/push/routes"));
app.use("/v1/ai", require("./modules/ai/routes"));

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", message: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.use(errorHandler);

module.exports = app;
