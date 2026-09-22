const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { requestId, requestLogger, errorHandler } = require("./middlewares/errorHandler");

const app = express();

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

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", message: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.use(errorHandler);

module.exports = app;
