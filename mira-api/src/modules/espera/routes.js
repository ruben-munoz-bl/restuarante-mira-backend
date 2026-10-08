/** /v1/espera — lista de espera por franja (con sesión). */
const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const restaurantsService = require("../restaurants/service");
const { limiteDelLocal } = require("../reservations/service");
const svc = require("./service");

const router = Router();

const unirseSchema = z.object({
  restauranteId: z.string().min(1).max(120),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora: z.string().regex(/^\d{2}:\d{2}$/),
  comensales: z.coerce.number().int().min(1).max(10),
});

function responderError(res, next, err) {
  if (err.code === "HAY_SITIO") return res.status(409).json({ error: "HAY_SITIO", message: err.message });
  if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
  if (err.status === 404) return res.status(404).json({ error: "NOT_FOUND", message: err.message });
  return next(err);
}

router.post("/", verifyFirebaseAuth, rateLimit(60000, 20), validate(unirseSchema), async (req, res, next) => {
  try {
    const d = req.validated;
    const restaurante = await restaurantsService.obtenerRestaurante(d.restauranteId);
    if (!restaurante) return res.status(404).json({ error: "NOT_FOUND", message: "Restaurante no encontrado" });
    const r = await svc.unirse({ ...d, uid: req.user.uid, nombre: req.user.email ? req.user.email.split("@")[0] : "" }, { restaurante, limite: limiteDelLocal(restaurante) });
    res.status(r.yaEstabas ? 200 : 201).json(r);
  } catch (err) {
    responderError(res, next, err);
  }
});

router.get("/mias", verifyFirebaseAuth, async (req, res, next) => {
  try {
    res.json({ items: await svc.listarMias(req.user.uid) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", verifyFirebaseAuth, async (req, res, next) => {
  try {
    res.json(await svc.salir(req.params.id, req.user.uid));
  } catch (err) {
    responderError(res, next, err);
  }
});

module.exports = router;
