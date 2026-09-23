/**
 * Tests de salud, rutas públicas y 404.
 * Carga el mock de Firebase ANTES de require del app.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, tokens } = require("./helpers/mockFirebase");

// Mock instalado al require del helper (side-effect en installFirebaseMock)
require("./helpers/mockFirebase");

let app;
let clearRateLimits;

before(async () => {
  app = require("../src/app");
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

beforeEach(() => {
  seedBase();
  if (clearRateLimits) clearRateLimits();
});

test("GET /health → 200 ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.ok(res.body.timestamp);
});

test("GET /v1/noexiste → 404 NOT_FOUND", async () => {
  const res = await request(app).get("/v1/noexiste");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "NOT_FOUND");
});

test("GET /v1/restaurants (público, optionalAuth) → 200", async () => {
  const res = await request(app).get("/v1/restaurants?limit=2");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length >= 2);
  assert.ok(res.body.items[0].id);
  // ordenado por rating desc: r2 (4.8) antes que r1 (4.5)
  assert.equal(res.body.items[0].id, "r2");
});

test("GET /v1/restaurants/count → total", async () => {
  const res = await request(app).get("/v1/restaurants/count");
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);
});

test("GET /v1/restaurants/:id inexistente → 404", async () => {
  const res = await request(app).get("/v1/restaurants/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "NOT_FOUND");
});

test("GET /v1/promotions (público) → 200", async () => {
  const res = await request(app).get("/v1/promotions");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
});

test("Headers de seguridad (helmet) presentes", async () => {
  const res = await request(app).get("/health");
  assert.ok(res.headers["x-content-type-options"]);
  assert.ok(res.headers["x-request-id"] || res.headers["x-request-id"] === "");
});
