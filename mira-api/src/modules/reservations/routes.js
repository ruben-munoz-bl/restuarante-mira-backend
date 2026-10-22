const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { idempotency, rateLimit } = require("../../middlewares/rateLimit");
const reservationService = require("./service");

const { documentoDelRestaurante } = require("../../middlewares/ownership");
const { precioSchema, ticketSchema } = require("../../middlewares/businessSchemas");
const { documentoId, fechaCalendario, horaReserva } = require("../../middlewares/inputSchemas");
const { pedidoSchema, listadoSchema } = require("./pedido");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const router = Router();

const crearReservaSchema = z.object({
  restauranteId: documentoId.optional(),
  restaurantId: documentoId.optional(),
  fecha: fechaCalendario,
  hora: horaReserva,
  comensales: z.union([z.number().int().min(1).max(10), z.string().trim().regex(/^(?:[1-9]|10)$/).transform(Number)]),
  comentarios: z.string().max(500).optional(),
  pedido: pedidoSchema.optional(),
  nombreRestaurante: z.string().max(200).optional(),
  usuarioNombre: z.string().max(200).optional(),
  usuarioEmail: z.union([z.string().email().max(254), z.literal("")]).optional(),
}).refine((d) => d.restaurantId || d.restauranteId, { message: "Restaurante requerido" });

const disponibilidadSchema = z.object({ restaurantId: documentoId.optional(), restauranteId: documentoId.optional(), fecha: fechaCalendario, hora: horaReserva }).refine((d) => d.restaurantId || d.restauranteId);
router.get("/availability", optionalAuth, validate(disponibilidadSchema, "query"), async (req, res, next) => {
  try {
    const restaurantId = req.query.restauranteId || req.query.restaurantId;
    const result = await reservationService.getDisponibilidad(
      restaurantId,
      req.query.fecha,
      req.query.hora,
      req.user?.uid || null,
    );
    res.json(result);
  } catch (err) {
    if (err.message.includes("no encontrado")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

router.post("/", verifyFirebaseAuth, rateLimit(60000, 20), validate(crearReservaSchema), idempotency, async (req, res, next) => {
  try {
    const result = await reservationService.crearReserva({
      uid: req.user.uid,
      usuario: { email: req.user.email, displayName: req.user.email },
      ...req.validated,
      comensales: parseInt(req.validated.comensales, 10),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.code === "PLATO_NO_DISPONIBLE") return res.status(400).json({ error: err.code, platoId: err.platoId });
    if (err.code === "SIN_CARTA") return res.status(400).json({ error: err.code });
    if (err.message.includes("Completo") || err.message.includes("Máximo")) {
      return res.status(409).json({ error: "CONFLICT", message: err.message });
    }
    if (err.message.includes("no válida") || err.message.includes("Comensales")) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    }
    next(err);
  }
});

router.get("/restaurante", verifyFirebaseAuth, authorize("empresa", "admin"), validate(listadoSchema, "query"), async (req, res, next) => {
  try {
    const { restauranteId, desde, hasta } = req.validated;
    await comprobarRestaurante(restauranteId, req.user);
    res.json({ data: await reservationService.delRestaurante(restauranteId, desde, hasta) });
  } catch (err) { next(err); }
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

router.put("/:id/complete", verifyFirebaseAuth, authorize("empresa", "admin"), documentoDelRestaurante("reservas"), validate(precioSchema), async (req, res, next) => {
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

router.post("/:id/ticket", verifyFirebaseAuth, authorize("empresa", "admin"), documentoDelRestaurante("reservas"), validate(ticketSchema), async (req, res, next) => {
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
