/**
 * Trazabilidad: cada petición deja un registro en `logs`, con o sin sesión.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, tokens, store } = require("./helpers/mockFirebase");

let app;
let flushLogs;
let clearRateLimits;

before(() => {
  app = require("../src/app");
  ({ flushLogs } = require("../src/middlewares/accessLog"));
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

beforeEach(async () => {
  seedBase();
  if (clearRateLimits) clearRateLimits();
  await new Promise((r) => setImmediate(r));
  await flushLogs();
  store.delete("logs");
});

async function logs() {
  await new Promise((r) => setImmediate(r)); // el finish resuelve el actor de forma asíncrona
  await flushLogs();
  return [...(store.get("logs")?.values() || [])];
}

test("petición anónima → registro con anonimo=true y sin uid", async () => {
  const res = await request(app).get("/v1/restaurants?limit=2&q=x");
  assert.equal(res.status, 200);
  const [l] = await logs();
  assert.equal(l.anonimo, true);
  assert.equal(l.uid, null);
  assert.equal(l.metodo, "GET");
  assert.equal(l.modulo, "restaurants");
  assert.equal(l.status, 200);
  assert.equal(l.ok, true);
  assert.deepEqual(l.queryKeys.sort(), ["limit", "q"]);
  assert.match(l.dia, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(l.expiraEn > l.ts, "debe tener fecha de expiración para TTL");
  assert.equal(typeof l.ms, "number");
});

test("petición con sesión → uid y rol, y ruta como patrón", async () => {
  await request(app).get("/v1/dashboard/users").set("Authorization", `Bearer ${tokens.admin}`);
  const [l] = await logs();
  assert.equal(l.uid, "u-admin");
  assert.equal(l.anonimo, false);
  assert.equal(l.ruta, "/v1/dashboard/users");
});

test("token en ruta pública → se identifica al usuario igualmente", async () => {
  await request(app).get("/v1/restaurants").set("Authorization", `Bearer ${tokens.cliente}`);
  const [l] = await logs();
  assert.equal(l.uid, "u-cli");
  assert.equal(l.anonimo, false);
});

test("token inválido → anónimo, y errores 4xx también se registran", async () => {
  await request(app).get("/v1/dashboard/users").set("Authorization", `Bearer ${tokens.invalid}`);
  await request(app).get("/v1/no-existe");
  const l = await logs();
  assert.equal(l.length, 2);
  assert.ok(l.every((x) => x.anonimo && x.ok === false));
  assert.deepEqual(l.map((x) => x.status).sort(), [401, 404]);
});

test("no guarda datos sensibles: ni IP en claro, ni token, ni body", async () => {
  await request(app).post("/v1/contactos").set("Authorization", `Bearer ${tokens.cliente}`).send({ email: "secreto@x.com", mensaje: "hola" });
  const [l] = await logs();
  const txt = JSON.stringify(l);
  assert.ok(!txt.includes("secreto@x.com"));
  assert.ok(!txt.includes(tokens.cliente));
  assert.ok(!txt.includes("127.0.0.1") && !txt.includes("::1"));
  assert.match(l.ipHash, /^[0-9a-f]{16}$/);
});

test("/health y OPTIONS no se registran; varias peticiones van en un lote", async () => {
  await request(app).get("/health");
  await request(app).options("/v1/restaurants");
  for (let i = 0; i < 5; i++) await request(app).get("/v1/restaurants");
  const l = await logs();
  assert.equal(l.length, 5);
});
