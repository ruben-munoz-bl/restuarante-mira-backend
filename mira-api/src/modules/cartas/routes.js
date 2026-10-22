const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const { documentoId } = require("../../middlewares/inputSchemas");
const { validate } = require("../../middlewares/validate");
const { asyncHandler } = require("../../middlewares/errorHandler");
const { cartaSchema } = require("./logica");
const svc = require("./service");
const router = Router();
const params = validate(z.object({ restauranteId: documentoId }), "params");
const dueño = [verifyFirebaseAuth, authorize("empresa", "admin"), params, asyncHandler(async (req, _res, next) => {
  await comprobarRestaurante(req.params.restauranteId, req.user); next();
})];
router.get("/:restauranteId/editar", ...dueño, asyncHandler(async (req, res) => {
  res.json(await svc.obtener(req.params.restauranteId, true));
}));
router.get("/:restauranteId", params, asyncHandler(async (req, res) => {
  res.json(await svc.obtener(req.params.restauranteId));
}));
router.put("/:restauranteId", ...dueño, validate(cartaSchema), asyncHandler(async (req, res) => {
  res.json(await svc.guardar(req.params.restauranteId, req.validated));
}));
module.exports = router;
