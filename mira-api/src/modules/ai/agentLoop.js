const { toolsForRole, getTool, checkAccess, toDeclaration, mapToolError, isEnabled } = require("./tools");
const checkReply = require("./guardrails/checkReply");
const { logger } = require("../../middlewares/errorHandler");

const MAX_ITER = 5;
const DEADLINE_MS = 25000;
// Presupuesto para seguir encadenando tools. Gemini 3.5-flash piensa (~6-10s por
// llamada), así que tras este margen forzamos la respuesta final sin tools.
const TOOL_BUDGET_MS = 9000;
const MAX_RESULT_CHARS = 2000;

function truncate(value) {
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined || s === null) s = "";
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)} ...[truncado]` : s;
}

function withTimeout(promise, ms) {
  if (ms <= 0) {
    const err = new Error("Tiempo agotado generando respuesta de IA");
    err.code = "AI_TIMEOUT";
    return Promise.reject(err);
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Tiempo agotado generando respuesta de IA");
      err.code = "AI_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function executeTool(tool, args, user) {
  const access = checkAccess(tool, user);
  if (access) return { ok: false, error: access.code, message: access.message };
  if (typeof tool.handler !== "function") {
    return {
      ok: false,
      error: "NOT_IMPLEMENTED",
      message: "Esta función aún no está disponible. Dilo al usuario y ofrece una alternativa.",
    };
  }
  try {
    const data = await tool.handler({ user }, args || {});
    return { ok: true, data };
  } catch (err) {
    const mapped = mapToolError(err);
    return { ok: false, error: mapped.code, message: mapped.message };
  }
}

async function runAgentLoop({ provider, system, history, message, user, onPending }) {
  const startedAt = Date.now();
  const deadline = startedAt + DEADLINE_MS;
  const available = toolsForRole(user ? user.role : null);
  const declarations = available.map(toDeclaration).filter(Boolean);

  const messages = [];
  for (const h of history || []) messages.push({ role: h.role, content: h.content });
  messages.push({ role: "user", content: message });

  const actions = [];
  let pending = null;
  let reply = null;
  let model = null;
  let retryUsed = false;
  let lastData = null;

  // Última llamada sin tools para que el modelo cierre la respuesta con lo que ya tiene.
  async function forceFinal() {
    const left = deadline - Date.now();
    if (left <= 500) return null;
    messages.push({
      role: "user",
      content:
        "[SISTEMA] Tiempo agotado para más consultas. NO llames a ninguna tool: responde ya al usuario " +
        "con los datos obtenidos arriba (o di honestamente que no hay resultados).",
    });
    const out = await withTimeout(
      provider.generate({ system, messages, tools: [], signal: undefined }),
      left,
    );
    return (out.text || "").trim();
  }

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const left = deadline - Date.now();
    if (left <= 0) break;

    let out;
    try {
      out = await withTimeout(
        provider.generate({ system, messages, tools: declarations, signal: undefined }),
        left,
      );
    } catch (err) {
      logger.error({ code: err.code || "AI_PROVIDER_ERROR", error: err.message, iter }, "ai.provider.generate");
      if (!reply && actions.length === 0) {
        return {
          reply: "El asistente no está disponible ahora mismo. Inténtalo de nuevo en unos segundos.",
          actions,
          pending,
          model,
          failed: true,
        };
      }
      break;
    }
    model = out.model || model;
    const calls = out.functionCalls || [];

    if (calls.length === 0) {
      const text = (out.text || "").trim();
      messages.push({ role: "model", content: text });
      if (!text) {
        reply = "No he podido generar una respuesta, ¿puedes reformularla?";
        break;
      }
      if (checkReply.detect(text, actions)) {
        if (!retryUsed) {
          retryUsed = true;
          messages.push({ role: "user", content: checkReply.RETRY_NOTE });
          continue;
        }
        reply = checkReply.fallbackReply();
        break;
      }
      reply = text;
      break;
    }

    messages.push({ role: "model", content: (out.text || "").trim(), functionCalls: calls });

    const results = [];
    for (const call of calls) {
      const args = call.args && typeof call.args === "object" ? call.args : {};
      const tool = getTool(call.name);

      if (!tool) {
        const r = { ok: false, error: "TOOL_NOT_FOUND", message: "Herramienta desconocida." };
        actions.push({ tool: call.name, args, result: r });
        results.push({ name: call.name, result: r });
        continue;
      }

      const access = checkAccess(tool, user);
      if (access) {
        const r = { ok: false, error: access.code, message: access.message };
        actions.push({ tool: call.name, args, result: r });
        results.push({ name: call.name, result: r });
        continue;
      }

      if (!isEnabled(tool)) {
        const r = { ok: false, error: "TOOL_DISABLED", message: "Herramienta deshabilitada." };
        actions.push({ tool: call.name, args, result: r });
        results.push({ name: call.name, result: r });
        continue;
      }

      if (tool.mutating) {
        if (pending) {
          const r = { ok: false, error: "AWAITING_CONFIRM", message: "Ya hay una operación pendiente de confirmación." };
          actions.push({ tool: call.name, args, result: r });
          results.push({ name: call.name, result: r });
          continue;
        }
        const summary =
          typeof tool.summarize === "function" ? tool.summarize(args) : `${tool.name}: ${truncate(args)}`;
        let confirmId = null;
        try {
          confirmId = onPending ? await onPending({ tool: tool.name, args, summary }) : null;
        } catch {
          const r = { ok: false, error: "CONFIRM_FAILED", message: "No se pudo preparar la confirmación." };
          actions.push({ tool: call.name, args, result: r });
          results.push({ name: call.name, result: r });
          continue;
        }
        pending = { tool: tool.name, args, summary, confirmId };
        actions.push({ tool: call.name, args, result: { pending: true, confirmId } });
        results.push({
          name: call.name,
          result: { ok: true, pending: true, confirmId, note: "Pendiente de confirmación del usuario; NO se ha ejecutado." },
        });
        continue;
      }

      const result = await executeTool(tool, args, user);
      actions.push({ tool: call.name, args, result });
      results.push({ name: call.name, result });
      if (result.ok) lastData = { tool: tool.name, data: result.data };
    }

    messages.push({ role: "user", functionResults: results });

    // Presupuesto de tools agotado (o sin tiempo): cerramos con una respuesta final sin tools.
    if (pending || Date.now() - startedAt > TOOL_BUDGET_MS || Date.now() > deadline - 4000) {
      try {
        const finalText = await forceFinal();
        model = model || null;
        if (finalText) reply = finalText;
      } catch (err) {
        logger.warn({ code: err.code || "AI_FINAL_ERROR", error: err.message }, "ai.loop.forceFinal");
      }
      break;
    }
  }

  if (!reply) {
    if (pending) {
      reply = `Tengo preparada esta operación: ${pending.summary}. ¿Confirmas?`;
    } else if (lastData) {
      // Se agotó el tiempo pero sí consultamos la API: mejor datos crudos que un "no pude".
      reply = truncate(lastData.data);
    } else if (Date.now() <= deadline) {
      reply = "He alcanzado el límite de pasos sin terminar. ¿Puedes simplificar la petición?";
    } else {
      reply = "No he podido terminar la consulta a tiempo. ¿Puedes intentarlo otra vez o simplificar la petición?";
    }
  }

  return { reply, actions, pending, model };
}

module.exports = { runAgentLoop, executeTool, withTimeout, truncate, MAX_ITER, DEADLINE_MS };
