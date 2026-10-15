/**
 * G02 — ofertas por distancia (contrato fase 1): reglas de niveles, una sola
 * activa por restaurante, lectura pública de la vigente y permisos de dueño.
 */
const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, seed, tokens, store, encodeToken } = require("./helpers/mockFirebase");
const { clearRateLimits } = require("../src/middlewares/rateLimit");

let app;
let logica;
before(() => {
  app = require("../src/app");
  logica = require("../src/modules/ofertas/logica");
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const otraEmpresa = encodeToken({ uid: "u-emp2", role: "empresa", email: "emp2@test.local" });
const niveles = (pcts = [5, 10, 15, 20]) => [1000, 500, 100, 20].map((distancia, i) => ({ distancia, texto: `Nivel ${distancia} m`, descuentoPct: pcts[i] }));
const oferta = (extra = {}) => ({ restauranteId: "r1", titulo: "Menú de mediodía", activa: true, niveles: niveles(), ...extra });
const crear = (cuerpo, token = tokens.empresa) => request(app).post("/v1/ofertas").set(auth(token)).send(cuerpo);
const sinRestaurante = ({ restauranteId, ...resto }) => resto;

beforeEach(() => {
  seedBase();
  clearRateLimits();
  seed("usuarios", "u-emp2", { uid: "u-emp2", tipo: "empresa", email: "emp2@test.local", nombre: "Otra empresa" });
  // r1 es de u-emp; r2 de u-emp2.
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("restaurants", "r2", { ...store.get("restaurants").get("r2"), ownerUid: "u-emp2" });
});

describe("reglas de niveles (logica)", () => {
  test("acepta niveles que mejoran o se mantienen y el de 20 m mejor que el de 1000 m", () => {
    assert.equal(logica.erroresNiveles(niveles([5, 10, 10, 20])), null);
  });
  test("rechaza orden distinto, niveles que faltan, que empeoran o llegada no mejor", () => {
    assert.match(logica.erroresNiveles(niveles().reverse()), /4 niveles/);
    assert.match(logica.erroresNiveles(niveles().slice(0, 3)), /4 niveles/);
    assert.match(logica.erroresNiveles(niveles([10, 5, 15, 20])), /igual o mejor/);
    assert.match(logica.erroresNiveles(niveles([10, 10, 10, 10])), /igual o mejor/);
  });
  test("vigente respeta activa, desde y hasta (incluidos)", () => {
    const o = { activa: true, desde: "2026-10-10", hasta: "2026-10-20" };
    assert.equal(logica.vigente(o, "2026-10-10"), true);
    assert.equal(logica.vigente(o, "2026-10-20"), true);
    assert.equal(logica.vigente(o, "2026-10-21"), false);
    assert.equal(logica.vigente({ ...o, activa: false }, "2026-10-15"), false);
  });
});

describe("POST /v1/ofertas", () => {
  test("la empresa dueña crea una oferta y la devuelve con id y fechas", async () => {
    const res = await crear(oferta());
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.restauranteId, "r1");
    assert.equal(res.body.niveles.length, 4);
    assert.equal(res.body.desde, null);
    assert.ok(res.body.creado && res.body.actualizado);
  });
  test("400 con detalles si los niveles empeoran o las fechas están al revés", async () => {
    const mal = await crear(oferta({ niveles: niveles([20, 10, 15, 25]) }));
    assert.equal(mal.status, 400);
    assert.equal(mal.body.error, "VALIDATION_ERROR");
    assert.ok(mal.body.details.niveles);
    const fechas = await crear(oferta({ desde: "2026-12-31", hasta: "2026-01-01" }));
    assert.equal(fechas.status, 400);
    assert.ok(fechas.body.details.hasta);
    assert.equal((await crear({ ...oferta(), extra: 1 })).status, 400, "campos desconocidos");
  });
  test("409 si ya hay otra activa; una inactiva sí se puede crear", async () => {
    assert.equal((await crear(oferta())).status, 201);
    const segunda = await crear(oferta({ titulo: "Cena" }));
    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.error, "CONFLICT");
    assert.equal((await crear(oferta({ titulo: "Cena", activa: false }))).status, 201);
  });
  test("permisos: 401 sin sesión, 403 cliente u otra empresa, 404 restaurante inexistente, admin sí", async () => {
    assert.equal((await request(app).post("/v1/ofertas").send(oferta())).status, 401);
    assert.equal((await crear(oferta(), tokens.cliente)).status, 403);
    assert.equal((await crear(oferta(), otraEmpresa)).status, 403);
    assert.equal((await crear(oferta({ restauranteId: "nope" }))).status, 404);
    assert.equal((await crear(oferta({ restauranteId: "r3" }), tokens.admin)).status, 201);
  });
});

describe("GET /v1/ofertas y /v1/ofertas/mias", () => {
  test("la pública solo devuelve la activa y vigente; mias devuelve todas", async () => {
    await crear(oferta({ titulo: "Antigua", activa: false }));
    await crear(oferta({ titulo: "Actual" }));
    const pub = await request(app).get("/v1/ofertas?restauranteId=r1");
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body.data.map((o) => o.titulo), ["Actual"]);
    const mias = await request(app).get("/v1/ofertas/mias?restauranteId=r1").set(auth(tokens.empresa));
    assert.equal(mias.body.data.length, 2);
  });
  test("una oferta activa fuera de su vigencia no sale en la pública", async () => {
    await crear(oferta({ desde: "2020-01-01", hasta: "2020-12-31" }));
    assert.deepEqual((await request(app).get("/v1/ofertas?restauranteId=r1")).body.data, []);
  });
  test("400 sin restauranteId; mias exige ser dueño", async () => {
    assert.equal((await request(app).get("/v1/ofertas")).status, 400);
    assert.equal((await request(app).get("/v1/ofertas/mias?restauranteId=r1").set(auth(otraEmpresa))).status, 403);
    assert.equal((await request(app).get("/v1/ofertas/mias?restauranteId=r1")).status, 401);
  });
});

describe("PUT y DELETE /v1/ofertas/:id", () => {
  test("editar sustituye los campos, no permite mover de restaurante y respeta la única activa", async () => {
    const a = (await crear(oferta())).body;
    const b = (await crear(oferta({ titulo: "Cena", activa: false }))).body;
    const editada = await request(app).put(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa)).send({ ...sinRestaurante(oferta()), titulo: "Menú nuevo", niveles: niveles([0, 5, 10, 30]) });
    assert.equal(editada.status, 200);
    assert.equal(editada.body.titulo, "Menú nuevo");
    assert.equal(editada.body.niveles[3].descuentoPct, 30);
    assert.equal((await request(app).put(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa)).send(oferta())).status, 400, "restauranteId no se acepta");
    assert.equal((await request(app).put(`/v1/ofertas/${b.id}`).set(auth(tokens.empresa)).send(sinRestaurante(oferta()))).status, 409);
  });
  test("otra empresa no puede editar ni borrar; 404 si no existe; la dueña borra", async () => {
    const a = (await crear(oferta())).body;
    assert.equal((await request(app).put(`/v1/ofertas/${a.id}`).set(auth(otraEmpresa)).send(sinRestaurante(oferta()))).status, 403);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(otraEmpresa))).status, 403);
    assert.equal((await request(app).delete("/v1/ofertas/nope").set(auth(tokens.empresa))).status, 404);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa))).status, 204);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa))).status, 404);
  });
});
