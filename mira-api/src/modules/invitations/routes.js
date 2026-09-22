const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const invitationService = require("./service");

const router = Router();

const inviteSchema = z.object({ emailInvitado: z.string().email() });
router.post("/", verifyFirebaseAuth, validate(inviteSchema), rateLimit(3600000, 5), async (req, res, next) => {
  try {
    const result = await invitationService.crearInvitacion(req.user.uid, req.validated.emailInvitado);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("Máximo")) return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
    if (err.message.includes("mismo")) return res.status(400).json({ error: "SELF_INVITE", message: err.message });
    next(err);
  }
});

const acceptSchema = z.object({ codigo: z.string().min(8) });
router.post("/accept", verifyFirebaseAuth, validate(acceptSchema), async (req, res, next) => {
  try {
    const result = await invitationService.aceptarInvitacion(req.validated.codigo, req.user.uid);
    res.json(result);
  } catch (err) {
    if (err.message.includes("no encontrada")) return res.status(404).json({ error: "NOT_FOUND" });
    if (err.message.includes("ya utilizada")) return res.status(409).json({ error: "ALREADY_USED" });
    next(err);
  }
});

router.get("/my", verifyFirebaseAuth, async (req, res, next) => {
  try {
    const result = await invitationService.getMyInvites(req.user.uid);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
