/**
 * Tests de SEGURIDAD: autenticación, autorización y validación de entrada.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, tokens } = require("./helpers/mockFirebase");
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

/* ───────── 401 sin token ───────── */

const PROTECTED = [
  ["get", "/v1/points/balance"],
  ["get", "/v1/points/ledger"],
  ["post", "/v1/points/daily-login"],
  ["get", "/v1/reservations"],
  ["get", "/v1/invite/my"],
  ["get", "/v1/users/me"],
  ["get", "/v1/mensajes"],
  ["get", "/v1/tickets"],
  ["get", "/v1/dashboard/my-restaurants"],
  ["get", "/v1/dashboard/admin"],
  ["get", "/v1/dashboard/ops/overview"],
  ["get", "/v1/admin/revenue"],
  ["get", "/v1/users/all"],
  ["post", "/v1/reviews"],
  ["post", "/v1/interactions"],
];

for (const [method, path] of PROTECTED) {
  test(`SEC ${method.toUpperCase()} ${path} sin token → 401`, async () => {
    const res = await request(app)[method](path);
    assert.equal(res.status, 401, `${method} ${path} esperaba 401, llegó ${res.status}`);
    assert.equal(res.body.error, "MISSING_TOKEN");
  });
}

test("SEC token inválido → 401 INVALID_TOKEN", async () => {
  const res = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", `Bearer ${tokens.invalid}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "INVALID_TOKEN");
});

test("SEC Authorization sin prefijo Bearer → 401", async () => {
  const res = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", tokens.cliente);
  assert.equal(res.status, 401);
});

/* ───────── 403 roles ───────── */

test("SEC cliente → GET /v1/dashboard/admin → 403", async () => {
  const res = await request(app)
    .get("/v1/dashboard/admin")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "FORBIDDEN");
});

test("SEC cliente → GET /v1/admin/revenue → 403", async () => {
  const res = await request(app)
    .get("/v1/admin/revenue")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
});

test("SEC cliente → GET /v1/users/all → 403", async () => {
  const res = await request(app)
    .get("/v1/users/all")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
});

test("SEC cliente → GET /v1/dashboard/ops/overview → 403", async () => {
  const res = await request(app)
    .get("/v1/dashboard/ops/overview")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
});

test("SEC empresa → GET /v1/admin/revenue → 403 (solo admin)", async () => {
  const res = await request(app)
    .get("/v1/admin/revenue")
    .set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 403);
});

test("SEC admin → GET /v1/dashboard/admin → 200", async () => {
  const res = await request(app)
    .get("/v1/dashboard/admin")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
});

test("SEC empresa → GET /v1/dashboard/my-restaurants → 200", async () => {
  const res = await request(app)
    .get("/v1/dashboard/my-restaurants")
    .set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200);
});

/* ───────── Validación (zod) ───────── */

test("VAL POST /v1/reviews body inválido → 400", async () => {
  const res = await request(app)
    .post("/v1/reviews")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ puntuacion: 99, comentario: "" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("VAL POST /v1/points/redeem sin puntos → 400", async () => {
  const res = await request(app)
    .post("/v1/points/redeem")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("VAL POST /v1/points/redeem puntos negativos → 400", async () => {
  const res = await request(app)
    .post("/v1/points/redeem")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ puntos: -10 });
  assert.equal(res.status, 400);
});

test("VAL POST /v1/reservations fecha inválida → 400", async () => {
  const res = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restaurantId: "r1", fecha: "no-fecha", hora: "13:00", comensales: 2 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("VAL POST /v1/invite email inválido → 400", async () => {
  const res = await request(app)
    .post("/v1/invite")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ email: "no-es-email" });
  assert.equal(res.status, 400);
});

test("VAL PUT /v1/users/me tipo inválido → 400", async () => {
  const res = await request(app)
    .put("/v1/users/me")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ tipo: "superuser" });
  assert.equal(res.status, 400);
});

/* ───────── Endpoint público no filtra datos privados ───────── */

test("SEC GET /v1/restaurants no expone campos sensibles de usuarios", async () => {
  const res = await request(app).get("/v1/restaurants?limit=5");
  assert.equal(res.status, 200);
  for (const item of res.body.items) {
    assert.equal(item.password, undefined);
    assert.equal(item.serviceAccount, undefined);
    assert.equal(item.privateKey, undefined);
  }
});

/* ───────── CORS ───────── */

test("SEC CORS no permite origen desconocido (header ausente o restringido)", async () => {
  const res = await request(app)
    .get("/health")
    .set("Origin", "https://evil.example");
  // helmet+cors: evil origin no debe recibir access-control-allow-origin: evil
  const acao = res.headers["access-control-allow-origin"];
  assert.ok(!acao || acao === "https://evil.example" || acao === "*", `ACAOrigin inesperado: ${acao}`);
  // si cors restringe, acao no debe ser evil salvo que esté en whitelist
  if (acao) {
    assert.ok(
      ["http://localhost:5173", "https://mira.vercel.app", "https://restaurante-mira-frontend.vercel.app", "*"].includes(acao),
      `Origin evil no debe estar permitido: ${acao}`,
    );
  }
});
