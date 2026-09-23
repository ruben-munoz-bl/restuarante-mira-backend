const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const negocioService = require("./service");

const router = Router();

const proponerSchema = z.object({
  nombre: z.string().min(1),
  ciudad: z.string().min(1),
  zona: z.string().min(1),
  direccion: z.string().min(1),
  precio: z.enum(["€", "€€", "€€€"]),
  categorias: z.array(z.string()).min(1),
  telefono: z.string().optional(),
  descripcion: z.string().optional(),
  imagen_url: z.string().optional(),
  accesoDiscapacidad: z.boolean().nullable().optional(),
  menuInfantil: z.boolean().nullable().optional(),
  entornoTranquilo: z.boolean().nullable().optional(),
  tronas: z.boolean().nullable().optional(),
  terraza: z.boolean().nullable().optional(),
  alergenos: z.string().optional(),
});

router.post("/", verifyFirebaseAuth, validate(proponerSchema), async (req, res, next) => {
  try {
    const result = await negocioService.proponerNegocio({
      uid: req.user.uid,
      email: req.user.email,
      datos: req.validated,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("obligatorio") || err.message.includes("Elige") || err.message.includes("no válido") || err.message.includes("Indica")) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    }
    next(err);
  }
});

router.get("/my", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const negocios = await negocioService.listarMisNegocios(req.user.uid);
    res.json({ data: negocios });
  } catch (err) {
    next(err);
  }
});

router.get("/pendientes", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const negocios = await negocioService.listarNegociosPendientes();
    res.json({ data: negocios });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/aprobar", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    const restaurantId = await negocioService.aprobarNegocio(req.params.id);
    res.json({ ok: true, restaurantId });
  } catch (err) {
    if (err.message.includes("ya no existe")) return res.status(404).json({ error: "NOT_FOUND", message: err.message });
    if (err.message.includes("aprobada")) return res.status(409).json({ error: "CONFLICT", message: err.message });
    next(err);
  }
});

router.put("/:id/rechazar", verifyFirebaseAuth, authorize("admin"), async (req, res, next) => {
  try {
    await negocioService.rechazarNegocio(req.params.id);
    res.json({ ok: true, estado: "rechazada" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
