/**
 * /v1/ofertas — ofertas por distancia (contrato fase 1).
 * Lectura pública de la oferta vigente; crear, editar y borrar solo la empresa
 * dueña del restaurante o un admin (comprobarRestaurante).
 */
const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const { documentoId } = require("../../middlewares/inputSchemas");
const { crearSchema, editarSchema } = require("./logica");
const svc = require("./service");

const router = Router();
const porRestaurante = z.object({ restauranteId: documentoId });
const porId = z.object({ id: documentoId });
const soloEmpresa = [verifyFirebaseAuth, authorize("empresa", "admin")];

function responder(res, next, err) {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || "ERROR", message: err.message });
  return next(err);
}

router.get("/", validate(porRestaurante, "query"), async (req, res, next) => {
  try {
    res.json({ data: await svc.publicas(req.validated.restauranteId) });
  } catch (err) { responder(res, next, err); }
});

router.get("/mias", ...soloEmpresa, validate(porRestaurante, "query"), async (req, res, next) => {
  try {
    await comprobarRestaurante(req.validated.restauranteId, req.user);
    res.json({ data: await svc.delRestaurante(req.validated.restauranteId) });
  } catch (err) { responder(res, next, err); }
});

router.post("/", ...soloEmpresa, rateLimit(60000, 30), validate(crearSchema), async (req, res, next) => {
  try {
    await comprobarRestaurante(req.validated.restauranteId, req.user);
    res.status(201).json(await svc.crear(req.validated));
  } catch (err) { responder(res, next, err); }
});

router.put("/:id", ...soloEmpresa, rateLimit(60000, 30), validate(porId, "params"), validate(editarSchema), async (req, res, next) => {
  try {
    const actual = await svc.obtener(req.params.id);
    await comprobarRestaurante(actual.restauranteId, req.user);
    res.json(await svc.editar(actual.id, req.validated));
  } catch (err) { responder(res, next, err); }
});

router.delete("/:id", ...soloEmpresa, validate(porId, "params"), async (req, res, next) => {
  try {
    const actual = await svc.obtener(req.params.id);
    await comprobarRestaurante(actual.restauranteId, req.user);
    await svc.borrar(actual.id);
    res.status(204).end();
  } catch (err) { responder(res, next, err); }
});

module.exports = router;
