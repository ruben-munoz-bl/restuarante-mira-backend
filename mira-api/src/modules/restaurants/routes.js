const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const restaurantService = require("./service");
const { urlFotoGoogle } = require("./fotoGoogle");

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

// Versión ligera para el mapa: 8 campos por restaurante (~9x menos que all=1).
// Se sirve desde el catálogo en memoria o desde el documento __catalogo__ (1 lectura).
router.get("/mapa", optionalAuth, async (req, res, next) => {
  try {
    const items = await restaurantService.listarMapa({ ciudad: req.query.ciudad || null });
    res.set("Cache-Control", "public, max-age=300");
    res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

// Foto de Google Places (verificada por fotos-places.js): redirige a la URL temporal de Google.
// Sin foto disponible responde 404 y la tarjeta usa su imagen de respaldo.
router.get("/:id/foto", async (req, res, next) => {
  try {
    const foto = await urlFotoGoogle(req.params.id);
    if (!foto?.url) return res.status(404).json({ error: "NOT_FOUND", message: "Sin foto de Google" });
    if (foto.autor) res.setHeader("X-Foto-Autor", encodeURIComponent(foto.autor));
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.redirect(302, foto.url);
  } catch (err) {
    next(err);
  }
});

// Diagnóstico de la caché del catálogo: cuántas cargas reales a Firestore se han hecho.
router.get("/cache/stats", optionalAuth, (req, res) => {
  res.json({ cache: restaurantService.estadisticasCache() });
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
