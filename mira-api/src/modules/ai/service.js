const { env } = require("../../config/env");
const { logger } = require("../../middlewares/errorHandler");
const { getProvider } = require("./provider");
const { buildSystemPrompt } = require("./systemPrompt");
const { runAgentLoop, executeTool, withTimeout, truncate } = require("./agentLoop");
const { getTool, isEnabled } = require("./tools");
const { createConfirm, takeConfirm } = require("./confirmStore");

const UNAVAILABLE_REPLY = "El asistente no está disponible ahora mismo. Inténtalo de nuevo en unos segundos.";
const PHRASE_TIMEOUT_MS = 8000;

function summarizeActions(actions) {
  return (actions || []).map((a) => ({
    tool: a.tool,
    ok: a.result ? a.result.ok !== undefined ? a.result.ok : Boolean(a.result.pending) : false,
    error: a.result && a.result.error ? a.result.error : null,
  }));
}

async function phrase({ provider, system, content }) {
  try {
    const out = await withTimeout(
      provider.generate({
        system,
        messages: [{ role: "user", content }],
        tools: [],
      }),
      PHRASE_TIMEOUT_MS,
    );
    return { text: (out.text || "").trim(), model: out.model || null };
  } catch {
    return { text: null, model: null };
  }
}

async function runConfirmed({ message, confirmId, user, system, hash, provider, requestId }) {
  const t0 = Date.now();

  if (!user) {
    logger.info({ requestId, promptHash: hash, reason: "confirm_anon" }, "ai.agent.confirm");
    return {
      reply: "Necesitas iniciar sesión para confirmar la operación.",
      actions: [],
      needsConfirm: undefined,
      provider: provider.name,
      model: null,
      promptHash: hash,
    };
  }

  const stored = await takeConfirm(confirmId, user);
  if (!stored) {
    logger.info({ requestId, uid: user.uid, promptHash: hash, reason: "confirm_invalid" }, "ai.agent.confirm");
    return {
      reply: "La confirmación no es válida, ya fue usada o ha caducado. Vuelve a iniciar la operación.",
      actions: [],
      needsConfirm: undefined,
      provider: provider.name,
      model: null,
      promptHash: hash,
    };
  }

  const tool = getTool(stored.tool);
  if (!tool || !isEnabled(tool)) {
    return {
      reply: "Esa operación ya no está disponible.",
      actions: [],
      needsConfirm: undefined,
      provider: provider.name,
      model: null,
      promptHash: hash,
    };
  }

  const result = await executeTool(tool, stored.args, user);
  const actions = [{ tool: stored.tool, args: stored.args, result }];

  let reply = null;
  let model = null;
  if (result.ok) {
    const phrased = await phrase({
      provider,
      system,
      content: `El usuario ha confirmado la operación "${stored.tool}" (${stored.summary}). Resultado: ${truncate(result)}. Mensaje del usuario: "${truncate(message)}". Informa del resultado en máximo 2 frases, en español, sin inventar datos.`,
    });
    reply = phrased.text;
    model = phrased.model;
  }
  if (!reply) {
    reply = result.ok
      ? `Operación completada: ${stored.summary}.`
      : result.message || "No se pudo completar la operación.";
  }

  logger.info(
    { requestId, uid: user.uid, promptHash: hash, provider: provider.name, model, confirmTool: stored.tool, ok: result.ok, error: result.error || null, ms: Date.now() - t0 },
    "ai.agent.confirm",
  );

  return { reply, actions, needsConfirm: undefined, provider: provider.name, model, promptHash: hash };
}

async function runAgent({ message, history = [], confirmId, user = null, requestId }) {
  const { prompt: system, hash } = buildSystemPrompt(user);

  let provider = null;
  try {
    provider = getProvider(env.AI_PROVIDER);
  } catch {
    provider = null;
  }
  if (!provider) {
    logger.error({ requestId, promptHash: hash, aiProvider: env.AI_PROVIDER }, "ai.provider.missing");
    return {
      reply: UNAVAILABLE_REPLY,
      actions: [],
      needsConfirm: undefined,
      provider: env.AI_PROVIDER,
      model: null,
      promptHash: hash,
      retryable: true,
    };
  }

  if (confirmId) {
    return runConfirmed({ message, confirmId, user, system, hash, provider, requestId });
  }

  const t0 = Date.now();
  const out = await runAgentLoop({
    provider,
    system,
    history,
    message,
    user,
    onPending: (p) => createConfirm({ uid: user.uid, role: user.role, ...p }),
  });

  const result = {
    reply: out.reply,
    actions: out.actions,
    needsConfirm: out.pending
      ? {
          confirmId: out.pending.confirmId,
          summary: out.pending.summary,
          payload: { tool: out.pending.tool, args: out.pending.args },
        }
      : undefined,
    provider: provider.name,
    model: out.model,
    promptHash: hash,
    retryable: Boolean(out.failed),
  };

  logger.info(
    {
      requestId,
      uid: user ? user.uid : null,
      promptHash: hash,
      provider: provider.name,
      model: out.model,
      actions: summarizeActions(out.actions),
      needsConfirm: Boolean(result.needsConfirm),
      ms: Date.now() - t0,
    },
    "ai.agent",
  );

  return result;
}

module.exports = { runAgent };
