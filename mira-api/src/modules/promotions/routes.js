const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const promotionService = require("./service");

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const promos = await promotionService.getPromociones({
      restauranteId: req.query.restauranteId,
      estado: req.query.estado,
    });
    res.json({ data: promos });
  } catch (err) {
    next(err);
  }
});

const crearPromoSchema = z.object({
  restauranteId: z.string().min(1),
  tipo: z.string().optional(),
  fechaInicio: z.string(),
  fechaFin: z.string(),
  presupuestoTotal: z.number().positive(),
  cpc: z.number().positive().optional(),
  puntosExtraPorReserva: z.number().int().optional(),
});
router.post("/", verifyFirebaseAuth, authorize("empresa", "admin"), validate(crearPromoSchema), async (req, res, next) => {
  try {
    const result = await promotionService.crearPromocion({ uid: req.user.uid, ...req.validated });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("No eres dueño")) return res.status(403).json({ error: "FORBIDDEN" });
    if (err.message.includes("solapada")) return res.status(409).json({ error: "CONFLICT" });
    next(err);
  }
});

router.get("/:id/stats", verifyFirebaseAuth, authorize("empresa", "admin"), async (req, res, next) => {
  try {
    const stats = await promotionService.getPromoStats(req.params.id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
