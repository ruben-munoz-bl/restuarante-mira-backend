const { toolsForRole, getTool, checkAccess, toDeclaration, mapToolError, isEnabled } = require("./tools");
const checkReply = require("./guardrails/checkReply");
const { logger } = require("../../middlewares/errorHandler");

const MAX_ITER = 5;
const DEADLINE_MS = 20000;
// Presupuesto para seguir encadenando tools. Responder rápido es mejor que
// agotar tiempo y cuota: forzamos el cierre para cerrar el turno con datos.
const TOOL_BUDGET_MS = 7000;
const MAX_RESULT_CHARS = 2000;

// Nunca mostramos JSON crudo al usuario: extraemos los campos que interesan.
function resumenLegible(data) {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object") return String(data).slice(0, 120);
  if (Array.isArray(data)) return resumenLista(data);
  if (Array.isArray(data.items)) return resumenLista(data.items);
  const partes = [];
  for (const key of [
    "nombre", "codigo", "estado", "saldo", "saldoPuntos", "puntos", "total",
    "fecha", "hora", "comensales", "email", "restaurante", "pendientes", "count",
  ]) {
    const v = data[key];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") {
      // Un nivel de anidado: si es un objeto con nombre, lo usamos.
      if (typeof v.nombre === "string" && v.nombre) {
        partes.push(`${key}: ${v.nombre}`);
        if (partes.length >= 4) break;
      }
      continue;
    }
    partes.push(`${key}: ${v}`);
    if (partes.length >= 4) break;
  }
  return partes.length ? partes.join(" · ") : null;
}

function resumenLista(items) {
  const nombres = items
    .map((i) => (i && typeof i === "object" ? i.nombre : i))
    .filter(Boolean)
    .slice(0, 5);
  if (!nombres.length) return null;
  const total = items.length;
  const lista = nombres.join(", ");
  return total > nombres.length ? `${lista} (y ${total - nombres.length} más)` : lista;
}

// Red de seguridad: si el modelo devuelve JSON o texto cortado, no lo mostramos tal cual.
function sanearReply(text) {
  if (!text) return text;
  const t = text.trim();
  const pareceJson = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  if (pareceJson) {
    let data = null;
    try {
      data = JSON.parse(t);
    } catch {
      data = null;
    }
    const resumen = resumenLegible(data);
    return resumen
      ? `Lo he consultado y esto es lo que hay: ${resumen}. ¿Quieres que te dé más detalle?`
      : "Ya lo he consultado, pero no he conseguido resumirlo. Dime qué detalle quieres y te lo digo.";
  }
  return text;
}

function conCierreBrusco(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 45) return false;
  return !/[.!?)»"']$/.test(t);
}

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
          reply:
            "Ahora mismo no puedo consultar nada, es un problema temporal de mi conexión. " +
            "Prueba a enviarlo otra vez en unos segundos y te lo resuelvo.",
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
      // Red de seguridad: si el modelo se queda sin presupuesto de salida, la
      // respuesta llega cortada a media frase. Se pide una versión corta.
      if (conCierreBrusco(text) && !retryUsed && Date.now() - startedAt < TOOL_BUDGET_MS) {
        retryUsed = true;
        logger.warn({ len: text.length }, "ai.reply.cortada");
        messages.push({
          role: "user",
          content: "[SISTEMA] Tu respuesta se ha cortado a media frase. Vuelve a responder de forma más BREVE: 2-3 frases como máximo y cierra la frase.",
        });
        continue;
      }
      if (conCierreBrusco(text)) reply = `${text.trim()}…`;
      else reply = text;
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

    // El texto que venga en un turno con tool calls es gratis: lo guardamos por si
    // no llegamos a redactar la respuesta final.
    const turnText = (out.text || "").trim();
    if (turnText && !reply) reply = turnText;

    messages.push({ role: "user", functionResults: results });

    // Presupuesto de tools agotado (o sin tiempo): cerramos con una respuesta final sin tools.
    // Si ya hay datos o una confirmación que redactar, merece la pena la llamada extra;
    // si no hay nada que decir, respondemos directamente y ahorramos cuota.
    if (pending || Date.now() - startedAt > TOOL_BUDGET_MS || Date.now() > deadline - 3500) {
      if (pending || lastData) {
        try {
          const finalText = await forceFinal();
          if (finalText) reply = finalText;
        } catch (err) {
          logger.warn({ code: err.code || "AI_FINAL_ERROR", error: err.message }, "ai.loop.forceFinal");
        }
      }
      break;
    }
  }

  if (!reply) {
    if (pending) {
      reply = `Tengo preparada esta operación: ${pending.summary}. ¿Confirmas?`;
    } else if (lastData) {
      // Se agotó el tiempo pero sí consultamos la API: resumen legible, NUNCA JSON crudo.
      const resumen = resumenLegible(lastData.data);
      reply = resumen
        ? `Lo he consultado y esto es lo que hay: ${resumen}. ¿Quieres que te dé más detalle?`
        : "Ya lo he consultado, pero no he conseguido resumirlo. Dime qué detalle quieres y te lo digo.";
    } else if (Date.now() <= deadline) {
      reply = "He alcanzado el límite de pasos sin terminar. ¿Puedes simplificar la petición?";
    } else {
      reply = "No he podido terminar la consulta a tiempo. ¿Puedes intentarlo otra vez o simplificar la petición?";
    }
  }

  const limpio = sanearReply(reply);
  if (limpio !== reply && reply) {
    logger.warn({ tool: lastData && lastData.tool, reason: "respuesta no presentable" }, "ai.reply.sanitizada");
  }
  return { reply: limpio, actions, pending, model };
}

module.exports = { runAgentLoop, executeTool, withTimeout, truncate, resumenLegible, sanearReply, conCierreBrusco, MAX_ITER, DEADLINE_MS };
