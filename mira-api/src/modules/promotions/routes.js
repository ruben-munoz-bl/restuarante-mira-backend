const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const promotionService = require("./service");

const { comprobarRestaurante, documentoDelRestaurante } = require("../../middlewares/ownership");
const { documentoId, fechaPromocion } = require("../../middlewares/inputSchemas");
const router = Router();

router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const promos = await promotionService.getPromociones({
      restauranteId: req.query.restauranteId,
      estado: req.query.estado,
      autenticado: Boolean(req.user),
    });
    res.json({ data: promos });
  } catch (err) {
    next(err);
  }
});

const crearPromoSchema = z.object({
  restauranteId: documentoId,
  tipo: z.string().trim().min(1).max(60).optional(),
  fechaInicio: fechaPromocion,
  fechaFin: fechaPromocion,
  presupuestoTotal: z.number().finite().positive().max(1000000),
  cpc: z.number().finite().positive().max(100).optional(),
  puntosExtraPorReserva: z.number().int().min(0).max(10000).optional(),
}).refine((d) => new Date(d.fechaFin) >= new Date(d.fechaInicio), { message: "La fecha final no puede preceder a la inicial" });
router.post("/", verifyFirebaseAuth, authorize("empresa", "admin"), validate(crearPromoSchema), async (req, res, next) => {
  try {
    await comprobarRestaurante(req.validated.restauranteId, req.user);
    const result = await promotionService.crearPromocion({ uid: req.user.uid, user: req.user, ...req.validated });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("No eres dueño")) return res.status(403).json({ error: "FORBIDDEN" });
    if (err.message.includes("solapada")) return res.status(409).json({ error: "CONFLICT" });
    next(err);
  }
});

const editarPromoSchema = z.object({
  fechaFin: fechaPromocion.optional(),
  presupuestoTotal: z.number().finite().positive().max(1000000).optional(),
  estado: z.enum(["pausada", "finalizada"]).optional(),
}).strict().refine(d => Object.keys(d).length > 0, { message: "Indica al menos un campo" });
router.put("/:id", verifyFirebaseAuth, authorize("empresa", "admin"),
  validate(z.object({ id: documentoId }), "params"), validate(editarPromoSchema), async (req, res, next) => {
    try { res.json(await promotionService.editarPromocion(req.params.id, req.validated, req.user)); }
    catch (err) { next(err); }
  });

router.get("/:id/stats", verifyFirebaseAuth, authorize("empresa", "admin"), documentoDelRestaurante("promociones"), async (req, res, next) => {
  try {
    const stats = await promotionService.getPromoStats(req.params.id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
