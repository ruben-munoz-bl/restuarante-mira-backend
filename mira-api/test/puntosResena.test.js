const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const request = require("supertest");
const app = require("../src/app");
const { clearRateLimits } = require("../src/middlewares/rateLimit");

const saldo = () => store.get("usuarios").get("u-cli").saldoPuntos;
const auth = (r) => r.set("Authorization", `Bearer ${tokens.cliente}`);

test.beforeEach(() => { seedBase(); clearRateLimits(); });

test("POST /points/review sin reseña → 400 y sin puntos", async () => {
  const r = await auth(request(app).post("/v1/points/review")).send({});
  assert.equal(r.status, 400);
  assert.equal(saldo(), 0);
});

test("POST /points/review con una reseña inexistente → 404 y sin puntos", async () => {
  const r = await auth(request(app).post("/v1/points/review")).send({ reviewId: "no-existe" });
  assert.equal(r.status, 404);
  assert.equal(saldo(), 0);
});

test("POST /points/review con la reseña de otro → 403 y sin puntos", async () => {
  seed("resenas", "ajena", { usuarioId: "u-otro", restauranteId: "r1", puntuacion: 5, comentario: "x" });
  const r = await auth(request(app).post("/v1/points/review")).send({ reviewId: "ajena" });
  assert.equal(r.status, 403);
  assert.equal(saldo(), 0);
});

test("crear una reseña da 20 puntos una sola vez, aunque se reintente", async () => {
  const crear = await auth(request(app).post("/v1/reviews")).send({ restauranteId: "r1", puntuacion: 5, comentario: "Muy bien" });
  assert.equal(crear.status, 201);
  assert.equal(crear.body.puntos, 20);
  assert.equal(saldo(), 20);
  const otra = await auth(request(app).post("/v1/points/review")).send({ reviewId: crear.body.id });
  assert.equal(otra.body.puntos, 0);
  assert.equal(saldo(), 20);
});

test("varias reseñas del mismo restaurante no suman más de 20", async () => {
  for (let i = 0; i < 3; i++) {
    await auth(request(app).post("/v1/reviews")).send({ restauranteId: "r1", puntuacion: 4, comentario: `reseña ${i}` });
  }
  assert.equal(saldo(), 20);
  await auth(request(app).post("/v1/reviews")).send({ restauranteId: "r2", puntuacion: 4, comentario: "otro sitio" });
  assert.equal(saldo(), 40);
});
