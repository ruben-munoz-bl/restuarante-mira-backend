const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const { documentoId, fechaCalendario } = require("../../middlewares/inputSchemas");
const service = require("./service");

const router = Router();
const soloEmpresa = [verifyFirebaseAuth, authorize("empresa", "admin")];
function manejar(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); } catch (err) {
      if (err.code === "LEJOS") return res.status(422).json({ error: "LEJOS", distanciaM: err.distanciaM });
      if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code, message: err.message });
      next(err);
    }
  };
}

router.post("/", verifyFirebaseAuth, authorize("cliente"), rateLimit(60000, 30), validate(z.object({
  restauranteId: documentoId,
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
}).strict()), manejar(async (req, res) => {
  res.status(201).json(await service.crear(req.user.uid, req.validated));
}));

router.post("/validar", ...soloEmpresa, rateLimit(60000, 60), validate(z.object({ qr: z.string().max(1024) }).strict()), manejar(async (req, res) => {
  res.json(await service.validar(req.validated.qr, req.user));
}));

router.get("/restaurante", ...soloEmpresa, validate(z.object({
  restauranteId: documentoId, fecha: fechaCalendario.optional(),
}).strict(), "query"), manejar(async (req, res) => {
  await comprobarRestaurante(req.validated.restauranteId, req.user);
  res.json({ data: await service.delRestaurante(req.validated.restauranteId, req.validated.fecha) });
}));

router.get("/:id", verifyFirebaseAuth, validate(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }), "params"), manejar(async (req, res) => {
  res.json(await service.obtener(req.params.id, req.user.uid));
}));

module.exports = router;
