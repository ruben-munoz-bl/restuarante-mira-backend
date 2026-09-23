const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const { env } = require("../../config/env");
const pointsService = require("./service");
const dailyLogin = require("./dailyLogin");

const router = Router();
const isDev = env.NODE_ENV !== "production";

router.get("/balance", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const balance = await pointsService.getBalance(req.user.uid);
    res.json(balance);
  } catch (err) {
    next(err);
  }
});

router.get("/is-new-user", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const isNew = await pointsService.isNewUser(req.user.uid);
    res.json({ isNew });
  } catch (err) {
    next(err);
  }
});

router.get("/ledger", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const ledger = await pointsService.getLedger(req.user.uid, {
      tipo: req.query.tipo,
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
    const result = await pointsService.redeem(req.user.uid, req.validated.puntos);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("insuficiente")) return res.status(400).json({ error: "INSUFFICIENT", message: err.message });
    next(err);
  }
});

router.post("/daily-login", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const result = await dailyLogin.reclamarLoginDiario(req.user.uid);
    res.status(result.yaReclamado ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/wheel/prizes", verifyFirebaseAuth, async (req, res) => {
  res.json({ prizes: pointsService.getWheelPrizes() });
});

router.post("/wheel", verifyFirebaseAuth, rateLimit(60000, 5), async (req, res, next) => {
  try {
    // force solo admin en dev (clientes no pueden saltarse el lock de 7 días).
    const force = isDev && req.query.force === "1" && req.user.role === "admin";
    const result = await pointsService.claimWheelReward(req.user.uid, { force });
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code || "ERROR", message: err.message });
    next(err);
  }
});

router.post("/review", verifyFirebaseAuth, rateLimit(60000, 5), async (req, res, next) => {
  try {
    const result = await pointsService.reviewPoints(req.user.uid);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
