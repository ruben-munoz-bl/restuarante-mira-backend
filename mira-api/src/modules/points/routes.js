const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
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

// Acepta varias formas porque conviven dos conceptos:
//  - "quiero gastar N puntos"            -> { puntos: 500 }
//  - "quiero el descuento de 5 €"       -> { descuentoId: "5" }  (id o euros)
//  - número como texto                   -> { puntos: "500" }     (típico de un input)
const redeemSchema = z
  .object({
    puntos: z.coerce.number().int().positive().optional(),
    descuentoId: z.union([z.coerce.number().positive(), z.coerce.number().int().positive(), z.string().min(1)]).optional(),
    restauranteId: z.string().min(1).optional().nullable(),
  })
  .refine((d) => d.puntos !== undefined || d.descuentoId !== undefined, {
    message: "Indica 'puntos' (número) o 'descuentoId' (5, 10 o 20)",
  });

router.post("/redeem", verifyFirebaseAuth, validate(redeemSchema), async (req, res, next) => {
  try {
    const { puntos, descuentoId, restauranteId } = req.validated;

    // Si viene descuentoId, se traduce a cupón (mismo resultado que /discount/claim).
    if (puntos === undefined) {
      const resultado = await pointsService.canjearDescuento(req.user.uid, descuentoId, restauranteId || null);
      return res.status(201).json({ ...resultado, canjeadoComo: "descuento" });
    }

    const result = await pointsService.redeem(req.user.uid, puntos);
    res.status(201).json({ ...result, canjeadoComo: "puntos" });
  } catch (err) {
    if (err.code === "INSUFFICIENT" || err.message.includes("insuficiente")) {
      return res.status(400).json({ error: "INSUFFICIENT", message: err.message });
    }
    if (err.code === "VALIDATION_ERROR") {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    }
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

router.post("/wheel", verifyFirebaseAuth, async (req, res, next) => {
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

const discountClaimSchema = z.object({
  descuentoId: z.string().min(1),
  restauranteId: z.string().min(1).optional().nullable(),
});

router.get("/discounts", verifyFirebaseAuth, async (req, res) => {
  res.json({ descuentos: pointsService.listarDescuentos() });
});

router.post("/discount/claim", verifyFirebaseAuth, validate(discountClaimSchema), async (req, res, next) => {
  try {
    const result = await pointsService.canjearDescuento(
      req.user.uid,
      req.validated.descuentoId,
      req.validated.restauranteId || null,
    );
    res.status(201).json(result);
  } catch (err) {
    if (err.code === "INSUFFICIENT") return res.status(400).json({ error: "INSUFFICIENT", message: err.message });
    if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    if (err.code === "NOT_FOUND") return res.status(404).json({ error: "NOT_FOUND", message: err.message });
    next(err);
  }
});

router.post("/review", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const result = await pointsService.reviewPoints(req.user.uid);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
