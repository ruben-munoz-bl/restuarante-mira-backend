const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const contactoService = require("./service");

const { rateLimit } = require("../../middlewares/rateLimit");
const router = Router();

const crearSchema = z.object({
  nombre: z.string().min(1).max(200),
  email: z.string().email(),
  motivo: z.string().min(1).max(200),
  mensaje: z.string().min(1).max(2000),
});

router.post("/", optionalAuth, rateLimit(60000, 20), validate(crearSchema), async (req, res, next) => {
  try {
    const result = await contactoService.crearContacto({
      uid: req.user?.uid || null,
      ...req.validated,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/mine", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const list = await contactoService.listarMisIncidencias(req.user.uid);
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get("/pending", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const list = await contactoService.listarPendientes();
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get("/resolved", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try { res.json(await contactoService.listarResueltas()); }
  catch (err) { next(err); }
});

const resolverSchema = z.object({
  propuestaResolucion: z.string().trim().min(1).max(4000),
  solucion: z.string().trim().min(1).max(4000),
  encargado: z.string().trim().min(1).max(200),
});

router.put("/:id/resolve", verifyFirebaseAuth, authorize("admin"), validate(resolverSchema), async (req, res, next) => {
  try {
    const result = await contactoService.resolverIncidencia(req.params.id, req.validated, req.user.uid);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
