const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const invitationService = require("./service");

const router = Router();

const inviteSchema = z.object({ email: z.string().email().optional(), emailInvitado: z.string().email().optional() })
  .refine((d) => d.email || d.emailInvitado, { message: "email requerido" });

router.post("/", verifyFirebaseAuth, validate(inviteSchema), async (req, res, next) => {
  try {
    const email = req.validated.email || req.validated.emailInvitado;
    const result = await invitationService.crearInvitacion(req.user.uid, email);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("Límite") || err.message.includes("Máximo")) return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
    if (err.message.includes("mismo")) return res.status(400).json({ error: "SELF_INVITE", message: err.message });
    next(err);
  }
});

const acceptSchema = z.object({ codigo: z.string().min(4) });
router.post("/accept", verifyFirebaseAuth, validate(acceptSchema), async (req, res, next) => {
  try {
    const result = await invitationService.aceptarInvitacion(req.validated.codigo, req.user.uid, req.user.email);
    res.json(result);
  } catch (err) {
    if (err.message.includes("no válida") || err.message.includes("no encontrada")) return res.status(404).json({ error: "NOT_FOUND", message: err.message });
    if (err.message.includes("ya usada") || err.message.includes("ya utilizada")) return res.status(409).json({ error: "ALREADY_USED" });
    if (err.message.includes("para ti")) return res.status(403).json({ error: "FORBIDDEN", message: err.message });
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
