const { createHash, timingSafeEqual } = require("node:crypto");
const { env } = require("../../config/env");
const { rateLimit } = require("../../middlewares/rateLimit");
const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth } = require("../../middlewares/verifyFirebaseAuth");
const { validate } = require("../../middlewares/validate");
const invitationService = require("./service");

const router = Router();

const eventoSchema = z.object({ event: z.string().min(1).max(100) }).passthrough();
const webhookSchema = z.object({
  event: z.string().min(1).max(100),
  email: z.string().max(320).optional(),
  "message-id": z.string().max(500).optional(),
});

function verificarTokenBrevo(req, res, next) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const esperado = env.BREVO_WEBHOOK_TOKEN || "";
  // Los hashes tienen la misma longitud incluso para tokens inválidos o vacíos.
  const hash = (value) => createHash("sha256").update(value).digest();
  const coincide = timingSafeEqual(hash(token), hash(esperado));
  if (!coincide || !esperado) return res.status(401).json({ error: "UNAUTHORIZED" });
  next();
}

router.post("/webhook/brevo", rateLimit(60000, 120), verificarTokenBrevo, validate(eventoSchema), (req, res, next) => {
  // Eventos futuros se reconocen sin consultar Firestore ni validar campos que no utilizamos.
  if (!invitationService.EVENTOS_BREVO.has(req.validated.event)) return res.status(200).json({ ok: true });
  next();
}, validate(webhookSchema), async (req, res, next) => {
  try {
    await invitationService.procesarEventoBrevo(req.validated);
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
});

const emailSchema = z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "No existe la dirección, compruebe antes de volver a enviar");
const inviteSchema = z.object({ email: emailSchema.optional(), emailInvitado: emailSchema.optional() })
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
