const { Router } = require("express");
const { z } = require("zod");
const { Expo } = require("expo-server-sdk");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { asyncHandler } = require("../../middlewares/errorHandler");
const service = require("./service");

const router = Router();
const tokenSchema = z.object({
  token: z.string().min(1).max(4096).regex(/^\S+$/),
  tipo: z.enum(["expo", "web"]),
  plataforma: z.enum(["android", "ios", "web"]),
  idioma: z.enum(["es", "ca", "en"]),
}).strict().refine(v => v.tipo !== "expo" || Expo.isExpoPushToken(v.token), {
  path: ["token"], message: "Token Expo inválido",
});

router.post("/tokens", verifyFirebaseAuth, validate(tokenSchema), asyncHandler(async (req, res) => {
  res.json(await service.registrarToken(req.user.uid, req.body));
}));

router.delete("/tokens/:id", verifyFirebaseAuth,
  validate(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }), "params"),
  asyncHandler(async (req, res) => {
    await service.borrarToken(req.user.uid, req.params.id);
    res.status(204).end();
  }));

module.exports = router;
