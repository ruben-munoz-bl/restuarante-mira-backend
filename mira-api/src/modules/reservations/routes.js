const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit, idempotency } = require("../../middlewares/rateLimit");
const reservationService = require("./service");

const router = Router();

const crearReservaSchema = z.object({
  restauranteId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora: z.string(),
  comensales: z.union([z.string(), z.number()]),
  comentarios: z.string().max(500).optional(),
});

router.post("/", verifyFirebaseAuth, validate(crearReservaSchema), rateLimit(), idempotency, async (req, res, next) => {
  try {
    const result = await reservationService.crearReserva({
      uid: req.user.uid,
      ...req.validated,
      comensales: parseInt(req.validated.comensales, 10),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("Completo") || err.message.includes("máximo")) {
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
    await reservationService.cancelarReserva(req.params.id, req.user.uid);
    res.json({ estado: "cancelada" });
  } catch (err) {
    if (err.message.includes("No autorizado")) return res.status(403).json({ error: "FORBIDDEN" });
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

module.exports = router;
