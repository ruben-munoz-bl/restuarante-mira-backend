/**
 * Trazabilidad: cada petición deja un registro en `logs`, con o sin sesión,
 * agrupado en bloques para no saturar Firestore.
 */
process.env.LOGS_ENABLED = "true";
process.env.LOGS_MAX_DOCS_DIA = "3";
process.env.LOGS_POR_DOC = "4";

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, tokens, store, mockDb } = require("./helpers/mockFirebase");

let app;
let flushLogs;
let resetLogs;
let clearRateLimits;

before(() => {
  app = require("../src/app");
  ({ flushLogs, _reset: resetLogs } = require("../src/middlewares/accessLog"));
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

const tick = () => new Promise((r) => setImmediate(r)); // el finish resuelve el actor de forma asíncrona

beforeEach(async () => {
  seedBase();
  if (clearRateLimits) clearRateLimits();
  await tick();
  await flushLogs();
  resetLogs();
  store.delete("logs");
});

async function bloques() {
  await tick();
  await flushLogs();
  return [...(store.get("logs")?.values() || [])];
}

async function registros() {
  return (await bloques()).flatMap((b) => b.registros);
}

test("petición anónima → registro con anonimo=true y sin uid", async () => {
  const res = await request(app).get("/v1/restaurants?limit=2&q=x");
  assert.equal(res.status, 200);
  const [b] = await bloques();
  const [l] = b.registros;
  assert.equal(l.anonimo, true);
  assert.equal(l.uid, null);
  assert.equal(l.metodo, "GET");
  assert.equal(l.modulo, "restaurants");
  assert.equal(l.status, 200);
  assert.deepEqual(l.queryKeys.sort(), ["limit", "q"]);
  assert.equal(typeof l.ms, "number");
  assert.match(b.dia, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(b.expiraEn > b.desde, "el bloque debe tener fecha de expiración para TTL");
  assert.deepEqual(b.uids, []);
});

test("petición con sesión → uid y rol, ruta como patrón, uid en el índice del bloque", async () => {
  await request(app).get("/v1/dashboard/users").set("Authorization", `Bearer ${tokens.admin}`);
  const [b] = await bloques();
  const [l] = b.registros;
  assert.equal(l.uid, "u-admin");
  assert.equal(l.anonimo, false);
  assert.equal(l.ruta, "/v1/dashboard/users");
  assert.deepEqual(b.uids, ["u-admin"]);
  assert.deepEqual(b.modulos, ["dashboard"]);
});

test("token en ruta pública → se identifica al usuario igualmente", async () => {
  await request(app).get("/v1/restaurants").set("Authorization", `Bearer ${tokens.cliente}`);
  const [l] = await registros();
  assert.equal(l.uid, "u-cli");
  assert.equal(l.anonimo, false);
});

test("token inválido y 404 → anónimos, y cuentan como errores del bloque", async () => {
  await request(app).get("/v1/dashboard/users").set("Authorization", `Bearer ${tokens.invalid}`);
  await request(app).get("/v1/no-existe");
  const [b] = await bloques();
  assert.equal(b.n, 2);
  assert.equal(b.errores, 2);
  assert.ok(b.registros.every((x) => x.anonimo));
  assert.deepEqual(b.registros.map((x) => x.status).sort(), [401, 404]);
});

test("no guarda datos sensibles: ni IP en claro, ni token, ni body", async () => {
  await request(app).post("/v1/contactos").set("Authorization", `Bearer ${tokens.cliente}`).send({ email: "secreto@x.com", mensaje: "hola" });
  const [l] = await registros();
  const txt = JSON.stringify(l);
  assert.ok(!txt.includes("secreto@x.com"));
  assert.ok(!txt.includes(tokens.cliente));
  assert.ok(!txt.includes("127.0.0.1") && !txt.includes("::1"));
  assert.match(l.ipHash, /^[0-9a-f]{16}$/);
});

test("/health y OPTIONS no se registran; varias peticiones caben en pocos documentos", async () => {
  await request(app).get("/health");
  await request(app).options("/v1/restaurants");
  for (let i = 0; i < 6; i++) await request(app).get("/v1/restaurants");
  const b = await bloques();
  assert.equal(b.reduce((s, x) => s + x.n, 0), 6);
  assert.equal(b.length, 2, "6 registros con LOGS_POR_DOC=4 → 2 documentos, no 6");
});

test("tope diario: al llegar a LOGS_MAX_DOCS_DIA deja de escribir", async () => {
  for (let i = 0; i < 4 * 5; i++) await request(app).get("/v1/restaurants");
  const b = await bloques();
  assert.equal(b.length, 3, "como mucho 3 documentos al día");
});

test("si Firestore falla, pausa la escritura y la API sigue respondiendo", async () => {
  const original = mockDb.collection;
  let intentos = 0;
  mockDb.collection = (name) => {
    if (name !== "logs") return original.call(mockDb, name);
    return { add: async () => { intentos++; throw Object.assign(new Error("Quota exceeded"), { code: 8 }); } };
  };
  try {
    const res = await request(app).get("/v1/restaurants");
    assert.equal(res.status, 200);
    await tick();
    await flushLogs();
    await request(app).get("/v1/restaurants");
    await tick();
    await flushLogs();
    assert.equal(intentos, 1, "tras el error no vuelve a intentarlo durante la pausa");
  } finally {
    mockDb.collection = original;
  }
});

test("apagado por defecto: sin LOGS_ENABLED=true no escribe nada", async () => {
  process.env.LOGS_ENABLED = "";
  try {
    await request(app).get("/v1/restaurants");
    await request(app).get("/v1/dashboard/users").set("Authorization", `Bearer ${tokens.admin}`);
    assert.equal((await bloques()).length, 0);
  } finally {
    process.env.LOGS_ENABLED = "true";
  }
});
