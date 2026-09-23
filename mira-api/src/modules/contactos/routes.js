const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const contactoService = require("./service");

const router = Router();

const crearSchema = z.object({
  nombre: z.string().min(1),
  email: z.string().email(),
  motivo: z.string().min(1),
  mensaje: z.string().min(1),
});

router.post("/", optionalAuth, validate(crearSchema), async (req, res, next) => {
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

router.put("/:id/resolve", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const result = await contactoService.resolverIncidencia(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
