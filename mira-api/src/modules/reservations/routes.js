const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { idempotency } = require("../../middlewares/rateLimit");
const reservationService = require("./service");

const router = Router();

const crearReservaSchema = z.object({
  restauranteId: z.string().min(1).optional(),
  restaurantId: z.string().min(1).optional(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora: z.string(),
  comensales: z.union([z.string(), z.number()]),
  comentarios: z.string().max(500).optional(),
  nombreRestaurante: z.string().optional(),
  usuarioNombre: z.string().optional(),
  usuarioEmail: z.string().optional(),
});

router.get("/availability", optionalAuth, async (req, res, next) => {
  try {
    const restaurantId = req.query.restauranteId || req.query.restaurantId;
    const result = await reservationService.getDisponibilidad(
      restaurantId,
      req.query.fecha,
      req.query.hora,
    );
    res.json(result);
  } catch (err) {
    if (err.message.includes("no encontrado")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

router.post("/", verifyFirebaseAuth, validate(crearReservaSchema), idempotency, async (req, res, next) => {
  try {
    const result = await reservationService.crearReserva({
      uid: req.user.uid,
      usuario: { email: req.user.email, displayName: req.user.email },
      ...req.validated,
      comensales: parseInt(req.validated.comensales, 10),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("Completo") || err.message.includes("Máximo")) {
      return res.status(409).json({ error: "CONFLICT", message: err.message });
    }
    if (err.message.includes("no válida") || err.message.includes("Comensales")) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    }
    next(err);
  }
});

router.get("/", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const reservas = await reservationService.listarReservas(req.user.uid, { estado: req.query.estado });
    res.json({ data: reservas });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/cancel", verifyFirebaseAuth, async (req, res, next) => {
  try {
    await reservationService.cancelarReserva(req.params.id, req.user.uid, req.user.role === "admin");
    res.json({ ok: true, estado: "cancelada" });
  } catch (err) {
    if (err.message.includes("No autorizado")) return res.status(403).json({ error: "FORBIDDEN" });
    if (err.message.includes("ya no existe")) return res.status(404).json({ error: "NOT_FOUND" });
    if (err.message.includes("cancelada")) return res.status(409).json({ error: "CONFLICT", message: err.message });
    next(err);
  }
});

router.put("/:id/complete", verifyFirebaseAuth, authorize("empresa", "admin"), async (req, res, next) => {
  try {
    const result = await reservationService.completarReserva(req.params.id, {
      uid: req.user.uid,
      precioManual: req.body.precioBase,
      emitidoPor: "restaurante-simulado",
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/ticket", verifyFirebaseAuth, authorize("empresa", "admin"), async (req, res, next) => {
  try {
    const result = await reservationService.subirTicket(req.params.id, {
      uid: req.user.uid,
      totalPagado: req.body.totalPagado,
      asistio: req.body.asistio !== false,
      fileName: req.body.fileName || "",
      tipoDocumento: req.body.tipoDocumento || "Ticket TPV",
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("ya tiene un ticket")) return res.status(409).json({ error: "CONFLICT", message: err.message });
    if (err.message.includes("no encontrada")) return res.status(404).json({ error: "NOT_FOUND" });
    if (err.message.includes("Importe")) return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    next(err);
  }
});

module.exports = router;
