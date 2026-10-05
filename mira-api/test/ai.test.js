const test = require("node:test");
const assert = require("node:assert");

const mockFirebase = require("./helpers/mockFirebase");
const geminiMock = require("./helpers/mockGemini");

const request = require("supertest");
const app = require("../src/app");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const { buildSystemPrompt } = require("../src/modules/ai/systemPrompt");

const { seedBase, store, tokens } = mockFirebase;

const AGENT = "/v1/ai/agent";
// Snapshot del prompt (CONTEXT + GUARDRAILS). Si cambia un .md, este test falla a propósito:
// revisa el cambio y actualiza la constante.
const PROMPT_HASH_SNAPSHOT = "e2185ae607d3ce4a";

function post(body, token) {
  const req = request(app).post(AGENT);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body);
}

function reservasSize() {
  return store.get("reservas") ? store.get("reservas").size : 0;
}

test.beforeEach(() => {
  seedBase();
  clearRateLimits();
  geminiMock.resetGemini();
});

test("validación: message y history", async () => {
  let res = await post({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");

  res = await post({ message: "" });
  assert.equal(res.status, 400);

  res = await post({ message: "x".repeat(2001) });
  assert.equal(res.status, 400);

  res = await post({
    message: "hola",
    history: Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? "model" : "user", content: `m${i}` })),
  });
  assert.equal(res.status, 400);

  res = await post({
    message: "hola",
    history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "model" : "user", content: `m${i}` })),
  });
  assert.equal(res.status, 200);
});

test("flujo lectura: tool antes de afirmar + header de hash de prompt", async () => {
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) return { calls: [{ name: "getRestaurant", args: { id: "r1" } }] };
    return { text: "Casa Lucio tiene 4.5 estrellas, cocina española en Madrid." };
  });

  const res = await post({ message: "¿Qué tal Casa Lucio?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, "gemini");
  assert.ok(res.body.model);
  assert.equal(res.body.actions.length, 1);
  assert.equal(res.body.actions[0].tool, "getRestaurant");
  assert.equal(res.body.actions[0].result.ok, true);
  assert.equal(res.body.actions[0].result.data.nombre, "Casa Lucio");
  assert.match(res.body.reply, /Casa Lucio/);
  assert.equal(res.headers["x-prompt-hash"], PROMPT_HASH_SNAPSHOT);

  const system = geminiMock.geminiCalls()[0].system;
  assert.match(system, /GUARDRAILS/);
  assert.match(system, /PRIORIDAD MÁXIMA/);
  assert.doesNotMatch(system, /Bearer\s+\S/);
  assert.doesNotMatch(system, /serviceAccountKey\.json/);
  assert.doesNotMatch(system, /GEMINI_API_KEY=\S/);
});

test("guardrail: respuesta inventada sin tool se filtra (anti-invento)", async () => {
  const inventada = "La Casa Lucio tiene 4.8 estrellas y cuesta 25€ por persona.";
  geminiMock.setGeminiHandler(() => ({ text: inventada }));

  const res = await post({ message: "Cuéntame de la Casa Lucio" });
  assert.equal(res.status, 200);
  assert.equal(geminiMock.geminiCalls().length, 2, "debe reintentar una vez");
  assert.ok(!/\b4.8\b/.test(res.body.reply), "no debe colar la nota inventada");
  assert.ok(!/25€/.test(res.body.reply), "no debe colar el precio inventado");
  assert.equal(res.body.actions.length, 0);
});

test("acción que modifica datos: 2 pasos con confirmId, un solo uso y sin reserva fantasma", async () => {
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) {
      return {
        calls: [{ name: "createReservation", args: { restauranteId: "r1", fecha: "2030-01-01", hora: "13:00", comensales: 4 } }],
      };
    }
    if (n === 2) return { text: "¿Confirmas la reserva en Casa Lucio?" };
    return { text: "Reserva creada, te esperamos." };
  });

  const res1 = await post({ message: "Mesa para 4 el 2030-01-01 a las 13:00 en r1" }, tokens.cliente);
  assert.equal(res1.status, 200);
  assert.ok(res1.body.needsConfirm, "debe devolver needsConfirm");
  assert.ok(res1.body.needsConfirm.confirmId);
  assert.match(res1.body.needsConfirm.summary, /r1 · 2030-01-01 13:00 · 4 pax/);
  assert.equal(res1.body.actions[0].result.pending, true);
  assert.equal(reservasSize(), 0, "no debe crear la reserva sin confirmar");

  const res2 = await post({ message: "sí, confirma", confirmId: res1.body.needsConfirm.confirmId }, tokens.cliente);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.needsConfirm, undefined);
  assert.equal(res2.body.actions[0].result.ok, true);
  assert.match(res2.body.reply, /Reserva/);
  assert.equal(reservasSize(), 1, "la reserva se crea solo tras confirmar");

  const res3 = await post({ message: "otra vez", confirmId: res1.body.needsConfirm.confirmId }, tokens.cliente);
  assert.equal(res3.status, 200);
  assert.match(res3.body.reply, /no es válida/);
  assert.equal(reservasSize(), 1, "el confirmId es de un solo uso");
});

test("guardrail 403: cliente no ejecuta tools admin y la tool ni se declara", async () => {
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) return { calls: [{ name: "addManualPoints", args: { uid: "u-cli", puntos: 100 } }] };
    return { text: "Esa operación es solo para administradores." };
  });

  const res = await post({ message: "Dame 100 puntos extra" }, tokens.cliente);
  assert.equal(res.status, 200);
  assert.equal(res.body.actions[0].result.error, "FORBIDDEN");
  assert.equal(res.body.needsConfirm, undefined);
  assert.equal(reservasSize(), 0);

  const declared = geminiMock.geminiCalls()[0].tools;
  assert.ok(!declared.includes("addManualPoints"), "tool admin no debe declararse a un cliente");
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 0, "los puntos no cambian");
});

test("guardrail 401: anónimo que pide saldo recibe MISSING_TOKEN", async () => {
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) return { calls: [{ name: "getBalance" }] };
    return { text: "Inicia sesión para ver tu saldo." };
  });

  const res = await post({ message: "¿Cuántos puntos tengo?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.actions[0].result.error, "MISSING_TOKEN");
  assert.match(res.body.reply, /sesión/);
});

test("sin fugas de secretos ni PII en la respuesta", async () => {
  geminiMock.setGeminiHandler(() => ({ text: "Hola, soy el asistente de MIRA." }));
  const res = await post({ message: "hola" }, tokens.cliente);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("Bearer"));
  assert.ok(!raw.includes("serviceAccount"));
  assert.ok(!raw.includes("GEMINI_API_KEY"));
  assert.ok(!raw.includes("u-cli"), "no debe filtrar el uid interno");
  assert.ok(!raw.includes("cli@test.local"), "no debe filtrar emails");
});

test("snapshot del prompt: hash de CONTEXT + GUARDRAILS", () => {
  const { hash, prompt } = buildSystemPrompt(null);
  assert.equal(hash, PROMPT_HASH_SNAPSHOT, "los .md han cambiado: revisa y actualiza el snapshot");
  assert.match(prompt, /MIRA/);
  assert.match(prompt, /PROTOCOLO ReAct/);
});

test("Idempotency-Key: no rompe cuando no hay needsConfirm (undefined en Firestore)", async () => {
  geminiMock.setGeminiHandler(() => ({ text: "Hola, ¿qué buscas hoy?" }));

  const res = await request(app)
    .post(AGENT)
    .set("Idempotency-Key", "11111111-2222-4333-8444-555555555555")
    .send({ message: "hola" });

  assert.equal(res.status, 200, "una Idempotency-Key nunca debe provocar 500");
  assert.equal(res.body.needsConfirm, undefined);
  assert.ok(res.body.reply);
  // La clave no debe incluir undefined en ninguna forma (Firestore lo rechaza).
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("needsConfirm"), "no se serializan claves ausentes");
});

test("Idempotency-Key: un 500 cacheado nunca se vuelve a servir", async () => {
  // Regresión: el middleware cacheaba tambien los 500, así que un fallo puntual
  // se reproducía para siempre con la misma Idempotency-Key.
  const { seed } = require("./helpers/mockFirebase");
  seed("idempotencyKeys", "anonymous_llave-envenenada", {
    status: 500,
    body: { error: "INTERNAL_ERROR", message: "Error interno" },
    createdAt: new Date(),
  });
  geminiMock.setGeminiHandler(() => ({ text: "respuesta buena" }));

  const res = await request(app)
    .post(AGENT)
    .set("Idempotency-Key", "llave-envenenada")
    .send({ message: "hola" });

  assert.equal(res.status, 200, "debe ignorar el error cacheado y responder de verdad");
  assert.equal(res.body.reply, "respuesta buena");
  assert.equal(res.body.error, undefined);
});

test("fechas: el prompt incluye la fecha actual para resolver meses relativos", () => {
  const { hoyISO } = require("../src/config/constants");
  const { prompt } = buildSystemPrompt(null);
  assert.match(prompt, new RegExp(hoyISO()), "el prompt debe traer el día actual (Europe/Madrid)");
  assert.match(prompt, /NUNCA reserves en una fecha anterior a hoy/);
});

test("fechas: NUNCA se crea una reserva en fecha pasada", async () => {
  const { getTool } = require("../src/modules/ai/tools");
  const { store } = require("./helpers/mockFirebase");
  const { hoyISO } = require("../src/config/constants");

  const tool = getTool("createReservation");
  const user = { uid: "u-cli", email: "cli@test.local", role: "cliente" };
  const pasado = "2020-01-15";
  const futuro = "2099-12-31";

  // Pasado: bloqueado con VALIDATION_ERROR y sin tocar Firestore.
  await assert.rejects(
    () => tool.handler({ user }, { restauranteId: "r1", fecha: pasado, hora: "21:00", comensales: 2 }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.match(err.message, /ya ha pasado|anterior a hoy/i);
      return true;
    },
  );
  assert.equal(store.has("reservas") ? store.get("reservas").size : 0, 0, "no debe crear nada");

  // El mes pasado que dijo el usuario: hoy es 2026-10, junio sería 2026-06 (pasado).
  const junioDeEsteAnio = `${hoyISO().slice(0, 4)}-06-15`;
  if (junioDeEsteAnio < hoyISO()) {
    await assert.rejects(
      () => tool.handler({ user }, { restauranteId: "r1", fecha: junioDeEsteAnio, hora: "21:00", comensales: 2 }),
      (err) => err.code === "VALIDATION_ERROR",
    );
  }

  // Futuro: se permite.
  const ok = await tool.handler({ user }, { restauranteId: "r1", fecha: futuro, hora: "21:00", comensales: 2 });
  assert.ok(ok && ok.id, "una fecha futura sí se crea");
});

test("fechas: hoy con franja ya pasada también se bloquea", async () => {
  const { getTool } = require("../src/modules/ai/tools");
  const { hoyISO } = require("../src/config/constants");
  const tool = getTool("createReservation");
  const user = { uid: "u-cli", email: "cli@test.local", role: "cliente" };
  const ahora = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  // 00:00 siempre está en pasado salvo justo a medianoche.
  if (ahora !== "00:00") {
    await assert.rejects(
      () => tool.handler({ user }, { restauranteId: "r1", fecha: hoyISO(), hora: "00:00", comensales: 2 }),
      (err) => err.code === "VALIDATION_ERROR",
    );
  }
});

test("nunca se muestra JSON crudo al usuario", async () => {
  const { resumenLegible, sanearReply } = require("../src/modules/ai/agentLoop");

  // 1. Sanitizar una respuesta que es JSON puro.
  const json = JSON.stringify({
    restaurante: { id: "r1", nombre: "Casa Lucio", stats: { totalReservas: 3 } },
    finanzas: null,
    proximasReservas: [],
  });
  const limpio = sanearReply(json);
  assert.doesNotMatch(limpio, /[{}"[\]]/, "no debe quedar JSON en la respuesta");
  assert.match(limpio, /Casa Lucio/);

  // 2. Resumen de listas con items.
  const resumen = resumenLegible({ items: [{ nombre: "A" }, { nombre: "B" }, { nombre: "C" }] });
  assert.match(resumen, /A, B, C/);

  // 3. Un texto normal NO se toca.
  assert.equal(sanearReply("Hola, ¿qué buscas?"), "Hola, ¿qué buscas?");
});

test("si la tool responde y el modelo calla, se entrega un resumen legible", async () => {
  // El modelo llama a la tool y luego no produce texto: el agente debe resumir,
  // nunca reventar con el JSON crudo (regresión del fallback anterior).
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) return { calls: [{ name: "countRestaurants" }] };
    return { text: "" };
  });

  const res = await post({ message: "cuántos restaurantes hay" });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body.reply, /[{}]/, "no debe filtrar JSON al usuario");
  assert.ok(res.body.reply.length > 0);
});

test("degradación: si el provider cae siempre responde 200 con retryable", async () => {
  geminiMock.setGeminiHandler(() => {
    throw new Error("503 Service Unavailable");
  });

  const res = await post({ message: "hola" });
  assert.equal(res.status, 200, "nunca debe devolver 5xx al usuario");
  assert.ok(res.body.reply.length > 0, "siempre debe devolver texto");
  assert.equal(res.body.retryable, true, "el frontend debe poder reintentar");
  assert.doesNotMatch(res.body.reply, /no est\u00e1 disponible/i);
});

test("provider fallback: si falla AI_MODEL se usa AI_FALLBACK_MODEL", async () => {
  const { env } = require("../src/config/env");
  let n = 0;
  geminiMock.setGeminiHandler(() => {
    n += 1;
    if (n === 1) throw new Error("quota exceeded");
    return { text: "Respuesta con modelo fallback" };
  });

  const res = await post({ message: "hola" });
  assert.equal(res.status, 200);
  const calls = geminiMock.geminiCalls();
  assert.equal(calls[0].model, env.AI_MODEL);
  assert.equal(calls[1].model, env.AI_FALLBACK_MODEL);
  assert.equal(res.body.model, env.AI_FALLBACK_MODEL);
  assert.equal(res.body.reply, "Respuesta con modelo fallback");
});

test("límite ReAct: máximo 5 iteraciones de tools y, con datos, se muestran", async () => {
  geminiMock.setGeminiHandler(() => ({
    calls: [{ name: "searchRestaurants", args: { limit: 5 } }],
  }));

  const res = await post({ message: "busca más" });
  assert.equal(res.status, 200);
  assert.equal(res.body.actions.length, 5, "nunca más de 5 iteraciones de tools");
  // Si el modelo encadena tools hasta el límite, el agente entrega los datos
  // consultados en lugar de un mensaje vacío de error.
  assert.match(res.body.reply, /Casa Lucio/);
  assert.equal(res.body.needsConfirm, undefined);
});

test("flag AI_ENABLED_TOOLS: activa tools extra y respeta el rol", () => {
  const { TOOLS } = require("../src/modules/ai/tools");
  const core = TOOLS.filter((t) => t.enabled);
  assert.equal(core.length, 7, "las 7 core de fase 1");

  // Todas las tools deben tener handler (fase 2 conectada).
  const sinHandler = TOOLS.filter((t) => typeof t.handler !== "function");
  assert.deepEqual(sinHandler.map((t) => t.name), [], "ninguna tool puede quedar sin handler");

  const { env } = require("../src/config/env");
  const original = env.AI_ENABLED_TOOLS;
  try {
    env.AI_ENABLED_TOOLS = "";
    assert.equal(require("../src/modules/ai/tools").toolsForRole("cliente").length, 7);

    env.AI_ENABLED_TOOLS = "getLedger";
    const conUna = require("../src/modules/ai/tools").toolsForRole("cliente").map((t) => t.name);
    assert.ok(conUna.includes("getLedger"));
    assert.equal(conUna.length, 8);

    env.AI_ENABLED_TOOLS = "all";
    const todas = require("../src/modules/ai/tools");
    const paraCliente = TOOLS.filter((t) => t.roles.includes("public") || t.roles.includes("cliente")).length;
    assert.equal(todas.toolsForRole("cliente").length, paraCliente);
    assert.ok(todas.toolsForRole("admin").length > todas.toolsForRole("cliente").length, "admin ve más");
  } finally {
    env.AI_ENABLED_TOOLS = original;
  }
});

test("rate limit: 10/min y 429 en la 11ª", async () => {
  for (let i = 0; i < 10; i++) {
    const res = await post({ message: `hola ${i}` });
    assert.equal(res.status, 200);
  }
  const res = await post({ message: "una más" });
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "RATE_LIMITED");
});
