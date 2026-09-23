const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { requestId, requestLogger, errorHandler } = require("./middlewares/errorHandler");

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
app.use(helmet());
app.use(cors({ origin: ["http://localhost:5173", "https://mira.vercel.app", "https://restaurante-mira-frontend.vercel.app"] }));
app.use(express.json());
app.use(requestId);
app.use(requestLogger);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/v1/reservations", require("./modules/reservations/routes"));
app.use("/v1/points", require("./modules/points/routes"));
app.use("/v1/tickets", require("./modules/tickets/routes"));
app.use("/v1/invite", require("./modules/invitations/routes"));
app.use("/v1/promotions", require("./modules/promotions/routes"));
app.use("/v1/interactions", require("./modules/interactions/routes"));
app.use("/v1/reviews", require("./modules/reviews/routes"));
app.use("/v1/admin", require("./modules/admin/routes"));
app.use("/v1/dashboard", require("./modules/dashboard/router"));
app.use("/v1/restaurants", require("./modules/restaurants/routes"));
app.use("/v1/negocios", require("./modules/negocios/routes"));
app.use("/v1/users", require("./modules/users/routes"));
app.use("/v1/contactos", require("./modules/contactos/routes"));
app.use("/v1/mensajes", require("./modules/mensajes/routes"));

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", message: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.use(errorHandler);

module.exports = app;
