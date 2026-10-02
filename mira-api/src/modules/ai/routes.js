const { Router } = require("express");
const { optionalAuth } = require("../../middlewares/verifyFirebaseAuth");
const { rateLimit, idempotency } = require("../../middlewares/rateLimit");
const { validate } = require("../../middlewares/validate");
const { agentSchema } = require("./schemas");
const aiService = require("./service");

const router = Router();

router.post("/agent", optionalAuth, rateLimit(60000, 10), validate(agentSchema), idempotency, async (req, res, next) => {
  try {
    const { message, history, confirmId } = req.validated;
    const out = await aiService.runAgent({
      message,
      history,
      confirmId,
      user: req.user,
      requestId: req.id,
    });
    if (out.promptHash) res.setHeader("X-Prompt-Hash", out.promptHash);
    // Firestore rechaza `undefined` al guardar, y el middleware de idempotencia
    // cachea este body. Solo incluimos las claves que tienen valor.
    const payload = {
      reply: out.reply,
      actions: out.actions,
      provider: out.provider,
      model: out.model,
    };
    if (out.needsConfirm) payload.needsConfirm = out.needsConfirm;
    if (out.retryable === true) payload.retryable = true;
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
