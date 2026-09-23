const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, db } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const reviewService = require("./service");

const router = Router();

const crearSchema = z.object({
  restauranteId: z.string().min(1),
  puntuacion: z.number().int().min(1).max(5),
  comentario: z.string().min(1),
});

router.post("/", verifyFirebaseAuth, validate(crearSchema), rateLimit(60000, 5), async (req, res, next) => {
  try {
    const userSnap = await db.collection("usuarios").doc(req.user.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const usuarioNombre = userData.nombre || req.user.email || "";
    const id = await reviewService.crearResena({
      restauranteId: req.validated.restauranteId,
      uid: req.user.uid,
      usuarioNombre,
      puntuacion: req.validated.puntuacion,
      comentario: req.validated.comentario,
    });
    let puntosResult = null;
    try {
      const { reviewPoints } = require("../points/service");
      puntosResult = await reviewPoints(req.user.uid);
    } catch { /* puntos best-effort */ }
    res.status(201).json({ id, reviewId: id, ...puntosResult });
  } catch (err) {
    if (err.message.includes("Puntuación") || err.message.includes("comentario")) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    }
    next(err);
  }
});

router.get("/user/:usuarioId", async (req, res, next) => {
  try {
    const list = await reviewService.listarResenasDeUsuario(req.params.usuarioId);
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get("/:restauranteId", async (req, res, next) => {
  try {
    const reviews = await reviewService.listarResenasDeRestaurante(req.params.restauranteId);
    res.json({ data: reviews });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/like", verifyFirebaseAuth, async (req, res, next) => {
  try {
    await reviewService.darLike(req.params.id, req.user.uid);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes("no encontrada")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

router.delete("/:id/like", verifyFirebaseAuth, async (req, res, next) => {
  try {
    await reviewService.quitarLike(req.params.id, req.user.uid);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes("no encontrada")) return res.status(404).json({ error: "NOT_FOUND" });
    next(err);
  }
});

module.exports = router;
