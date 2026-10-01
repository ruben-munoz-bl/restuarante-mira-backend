const { GoogleGenerativeAI } = require("@google/generative-ai");
const { env } = require("../../../config/env");

const name = "gemini";
const RETRY_ATTEMPTS = 2;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toContents(messages) {
  const contents = [];

  for (const msg of messages || []) {
    if (msg.role === "user") {
      const results = msg.functionResults || [];
      if (results.length > 0) {
        const parts = results.map(({ name: fnName, result }) => ({
          functionResponse: {
            name: fnName,
            response: isPlainObject(result) ? result : { value: result },
          },
        }));
        if (msg.content) parts.push({ text: msg.content });
        contents.push({ role: "user", parts });
      } else {
        contents.push({ role: "user", parts: [{ text: msg.content || "" }] });
      }
    } else if (msg.role === "model") {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const fc of msg.functionCalls || []) {
        const part = { functionCall: { name: fc.name, args: fc.args || {} } };
        // Gemini 3.x exige reenviar id y thoughtSignature al ecoar un functionCall.
        if (fc.id) part.functionCall.id = fc.id;
        if (fc.thoughtSignature) part.thoughtSignature = fc.thoughtSignature;
        parts.push(part);
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
    }
  }

  return contents;
}

function parseResult(res, model) {
  const parts = res?.response?.candidates?.[0]?.content?.parts;

  let text = "";
  const functionCalls = [];

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part.text === "string") text += part.text;
      if (part.functionCall) {
        functionCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          id: part.functionCall.id || undefined,
          thoughtSignature: part.thoughtSignature || undefined,
        });
      }
    }
  }

  return { text, functionCalls, model };
}

async function generateOnce(genAI, model, system, contents, tools, signal) {
  const instance = genAI.getGenerativeModel({
    model,
    systemInstruction: system,
    generationConfig: {
      maxOutputTokens: env.AI_MAX_TOKENS,
      temperature: env.AI_TEMPERATURE,
    },
  });

  const payload = { contents };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = [{ functionDeclarations: tools }];
  }

  // `signal` no está en RequestOptions (opciones de getGenerativeModel), pero
  // sí en SingleRequestOptions (2.º argumento de generateContent), así que se
  // pasa ahí. Si el caller no envía signal, el timeout lo resuelve con Promise.race.
  const res = await instance.generateContent(
    payload,
    signal ? { signal } : undefined,
  );

  return parseResult(res, model);
}

// Errores transitorios de cuota/carga (429/5xx/red): merece la pena un reintento
// con espera corta antes de saltar al modelo de fallback.
const TRANSIENT = /429|500|502|503|504|Too Many|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(err) {
  const header = err && err.response && err.response.headers && err.response.headers.get
    ? err.response.headers.get("retry-after")
    : null;
  const parsed = parseInt(header, 10);
  if (Number.isFinite(parsed)) return Math.min(Math.max(parsed * 1000, 200), 3000);
  return 600;
}

async function generateWithRetry(genAI, model, system, contents, tools, signal) {
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await generateOnce(genAI, model, system, contents, tools, signal);
    } catch (err) {
      lastErr = err;
      if (attempt === 1 || !TRANSIENT.test(String(err && err.message))) break;
      await sleep(retryDelayMs(err));
    }
  }
  throw lastErr;
}

async function generate({ system, messages, tools, signal }) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY || "missing-key");
  const contents = toContents(messages);
  const models = [...new Set([env.AI_MODEL, env.AI_FALLBACK_MODEL].filter(Boolean))];

  let lastErr = null;
  for (const model of models) {
    try {
      return await generateWithRetry(genAI, model, system, contents, tools, signal);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Ningún modelo de IA disponible");
}

module.exports = { name, generate };
