const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { registrarVista, registrarClick } = require("./service");
const { logAudit } = require("../audit/service");

const router = Router();

const interactionSchema = z.object({
  restauranteId: z.string().min(1),
  tipo: z.enum(["view", "click"]),
});
router.post("/", verifyFirebaseAuth, validate(interactionSchema), async (req, res, next) => {
  try {
    const { restauranteId, tipo } = req.validated;
    const result = tipo === "view"
      ? await registrarVista(req.user.uid, restauranteId)
      : await registrarClick(req.user.uid, restauranteId);

    await logAudit({ actorUid: req.user.uid, accion: `interaction_${tipo}`, entidad: "promocion", entidadId: restauranteId });

    if (result.sinPromo) return res.status(404).json({ error: "NO_PROMO", message: "No hay promoción activa" });
    if (result.yaVisto) return res.json({ puntos: 0, message: "Ya registrado" });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
