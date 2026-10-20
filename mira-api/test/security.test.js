/**
 * Tests de SEGURIDAD: autenticación, autorización y validación de entrada.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, seed, tokens } = require("./helpers/mockFirebase");
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

test("SEC empresa → GET /v1/dashboard/my-restaurant sin restaurante → 404 NOT_FOUND", async () => {
  const res = await request(app)
    .get("/v1/dashboard/my-restaurant")
    .set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "NOT_FOUND");
  assert.match(res.body.message, /no tiene ningún restaurante asignado/);
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

test("SEC CORS permite únicamente los orígenes locales por defecto", async () => {
  for (const origin of ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:5173", "http://127.0.0.1:4173"]) {
    const res = await request(app).get("/health").set("Origin", origin);
    assert.equal(res.headers["access-control-allow-origin"], origin);
  }
});

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
      ["http://localhost:5173", "http://localhost:4173", "*"].includes(acao) ||
        acao.endsWith(".vercel.app"),
      `Origin evil no debe estar permitido: ${acao}`,
    );
  }
});

/* ───────── Endurecimiento (2026-10-20) ───────── */

test("SEC GET /v1/reviews/user/:uid inexistente → 404 (no se pueden sondear ids)", async () => {
  const res = await request(app).get("/v1/reviews/user/no-existo");
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "NOT_FOUND");
});

test("SEC GET /v1/reviews/user/:uid existente → 200", async () => {
  const res = await request(app).get("/v1/reviews/user/u-cli");
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("SEC POST /v1/negocios con imagen_url http → 400 (solo https)", async () => {
  const negocio = {
    nombre: "Bar Malo", ciudad: "Madrid", zona: "Centro", direccion: "Calle 1",
    precio: "€€", categorias: ["Bar"],
  };
  const res = await request(app)
    .post("/v1/negocios")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ ...negocio, imagen_url: "http://inseguro.com/x.jpg" });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.details?.imagen_url, "el error debe señalar imagen_url");
});

test("SEC POST /v1/negocios con imagen_url https → 201", async () => {
  const res = await request(app)
    .post("/v1/negocios")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({
      nombre: "Bar Bueno", ciudad: "Madrid", zona: "Centro", direccion: "Calle 2",
      precio: "€€", categorias: ["Bar"], imagen_url: "https://seguro.com/x.jpg",
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("SEC GET /v1/promotions público → no expone presupuestoTotal ni gastoAcumulado", async () => {
  seed("promociones", "promo-pub", {
    restauranteId: "r1", estado: "activa", presupuestoTotal: 500, gastoAcumulado: 120,
    views: 3, clicks: 1,
  });
  const res = await request(app).get("/v1/promotions");
  assert.equal(res.status, 200);
  const promo = res.body.data.find((p) => p.id === "promo-pub");
  assert.ok(promo, "la promo debe aparecer");
  assert.equal(promo.presupuestoTotal, undefined);
  assert.equal(promo.gastoAcumulado, undefined);
});

test("SEC GET /v1/promotions autenticado → conserva presupuestoTotal y gastoAcumulado", async () => {
  seed("promociones", "promo-priv", {
    restauranteId: "r1", estado: "activa", presupuestoTotal: 500, gastoAcumulado: 120,
  });
  const res = await request(app)
    .get("/v1/promotions")
    .set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200);
  const promo = res.body.data.find((p) => p.id === "promo-priv");
  assert.ok(promo, "la promo debe aparecer");
  assert.equal(promo.presupuestoTotal, 500);
  assert.equal(promo.gastoAcumulado, 120);
});

const RATE_CASES = [
  ["/v1/reviews", 10, tokens.cliente],
  ["/v1/negocios", 10, tokens.cliente],
  ["/v1/invite", 10, tokens.empresa],
  ["/v1/reservations", 20, tokens.cliente],
  ["/v1/points/redeem", 30, tokens.cliente],
];

for (const [path, max, token] of RATE_CASES) {
  test(`SEC POST ${path} → 429 tras ${max} peticiones`, async () => {
    for (let i = 1; i <= max; i++) {
      const res = await request(app)
        .post(path)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      assert.equal(res.status, 400, `petición ${i}: ${JSON.stringify(res.body)}`);
    }
    const bloqueada = await request(app)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(bloqueada.status, 429, JSON.stringify(bloqueada.body));
    assert.equal(bloqueada.body.error, "RATE_LIMITED");
  });
}

test("SEC body JSON > 1mb → 413", async () => {
  const res = await request(app)
    .post("/v1/reviews")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restauranteId: "r1", puntuacion: 5, comentario: "x".repeat(1_100_000) });
  assert.equal(res.status, 413, JSON.stringify(res.body));
});

test("SEC POST /v1/auditoria/purge en producción sin AUDITORIA_PURGE_ALLOW → 403", async () => {
  const { env } = require("../src/config/env");
  const anterior = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    const res = await request(app)
      .post("/v1/auditoria/purge?anios=1")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ confirmacion: "PURGAR" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "FORBIDDEN");
  } finally {
    env.NODE_ENV = anterior;
  }
});
