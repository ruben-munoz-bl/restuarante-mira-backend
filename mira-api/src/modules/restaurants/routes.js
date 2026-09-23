const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const restaurantService = require("./service");

const router = Router();

router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const result = await restaurantService.listarRestaurantes({
      limit: req.query.limit !== undefined ? parseInt(req.query.limit, 10) : restaurantService.TAMANO_PAGINA,
      all,
      cursor: req.query.cursor || null,
      ratingYelp: req.query.ratingYelp,
      ciudad: req.query.ciudad,
      zona: req.query.zona,
      cocina: req.query.cocina,
      q: req.query.q || null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/count", optionalAuth, async (req, res, next) => {
  try {
    const total = await restaurantService.contarRestaurantes();
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const restaurante = await restaurantService.obtenerRestaurante(req.params.id);
    res.json(restaurante);
  } catch (err) {
    if (err.message.includes("no encontrado")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

const updateSchema = z.object({
  nombre: z.string().optional(),
  direccion: z.string().optional(),
  telefono: z.string().optional(),
  email: z.string().email().optional(),
  horarios: z.any().optional(),
  activo: z.boolean().optional(),
  ciudad: z.string().optional(),
  zona: z.string().optional(),
  precio: z.string().optional(),
  cocina: z.string().optional(),
  descripcion: z.string().optional(),
  comisionPct: z.number().optional(),
  maxReservasPorHora: z.number().optional(),
});

router.put("/:id", verifyFirebaseAuth, validate(updateSchema), async (req, res, next) => {
  try {
    const result = await restaurantService.actualizarRestaurante(req.params.id, req.user.uid, req.validated);
    res.json(result);
  } catch (err) {
    if (err.message.includes("no encontrado")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

module.exports = router;
