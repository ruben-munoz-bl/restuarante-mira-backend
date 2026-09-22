const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const pointsService = require("./service");
const dailyLogin = require("./dailyLogin");

const router = Router();

router.get("/balance", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const balance = await pointsService.getBalance(req.user.uid);
    res.json(balance);
  } catch (err) {
    next(err);
  }
});

router.get("/ledger", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const ledger = await pointsService.getLedger(req.user.uid, {
      tipo: req.query.tipo,
      page: parseInt(req.query.page || "1", 10),
      limit: parseInt(req.query.limit || "20", 10),
    });
    res.json(ledger);
  } catch (err) {
    next(err);
  }
});

const redeemSchema = z.object({ puntos: z.number().int().positive() });
router.post("/redeem", verifyFirebaseAuth, validate(redeemSchema), rateLimit(60000, 10), async (req, res, next) => {
  try {
    const result = await pointsService.redeemPoints(req.user.uid, req.validated.puntos);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("insuficiente")) return res.status(400).json({ error: "INSUFFICIENT", message: err.message });
    if (err.message.includes("múltiplo")) return res.status(400).json({ error: "INVALID_AMOUNT", message: err.message });
    next(err);
  }
});

router.post("/daily-login", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const result = await dailyLogin.reclamarLoginDiario(req.user.uid);
    if (result.yaReclamado) return res.status(200).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const reviewSchema = z.object({
  restauranteId: z.string().min(1),
  puntuacion: z.number().int().min(1).max(5),
  comentario: z.string().min(20),
});
router.post("/review", verifyFirebaseAuth, validate(reviewSchema), rateLimit(60000, 5), async (req, res, next) => {
  try {
    const { crearReview } = require("../reviews/service");
    const result = await crearReview(req.user.uid, req.validated);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("asistido")) return res.status(422).json({ error: "NO_ATTENDANCE", message: err.message });
    if (err.message.includes("Ya reseñaste")) return res.status(409).json({ error: "ALREADY_REVIEWED", message: err.message });
    next(err);
  }
});

module.exports = router;
