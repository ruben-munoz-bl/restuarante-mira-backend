/**
 * Mejoras MIRA: lista de espera (aviso + plaza retenida 30 min), reserva en
 * grupo tipo JAM (votación en directo y reserva automática) y métricas de carga.
 */
const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, seed, tokens, store, encodeToken } = require("./helpers/mockFirebase");

let app;
let espera;
let jams;
let logica;
let metricas;
const { clearRateLimits } = require("../src/middlewares/rateLimit");

before(() => {
  app = require("../src/app");
  espera = require("../src/modules/espera/service");
  jams = require("../src/modules/jams/service");
  logica = require("../src/modules/jams/logica");
  metricas = require("../src/modules/metricas/metricas");
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const manana = () => { const d = new Date(Date.now() + 2 * 86400000); return d.toISOString().slice(0, 10); };
const docs = (c) => [...(store.get(c)?.values() || [])];
const aforoDe = (rest, fecha, hora) => store.get("aforo")?.get(`${rest}_${fecha}_${hora}`);

beforeEach(() => {
  seedBase();
  clearRateLimits();
  jams._reset();
  metricas._reset();
  // r3 (Pizzeria Roma) tiene 50 reseñas → aforo 4 por franja.
});

async function reservar(token, fecha, hora, rest = "r3") {
  return request(app).post("/v1/reservations").set(auth(token)).send({ restauranteId: rest, restaurantId: rest, fecha, hora, comensales: 2 });
}

async function llenar(fecha, hora, rest = "r3") {
  seed("aforo", `${rest}_${fecha}_${hora}`, { ocupadas: 4, limite: 4 });
}

describe("lista de espera", () => {
  test("no deja apuntarse si hay mesa libre", async () => {
    const res = await request(app).post("/v1/espera").set(auth(tokens.cliente)).send({ restauranteId: "r3", fecha: manana(), hora: "21:00", comensales: 2 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "HAY_SITIO");
  });

  test("al cancelarse una reserva avisa al primero, le retiene la plaza y solo él puede reservarla", async () => {
    const f = manana();
    // u-cli2 reserva y luego se llena la franja
    const r1 = await reservar(tokens.cliente2, f, "21:00");
    assert.equal(r1.status, 201);
    seed("aforo", `r3_${f}_21:00`, { ...aforoDe("r3", f, "21:00"), ocupadas: 4, limite: 4 });

    const unir = await request(app).post("/v1/espera").set(auth(tokens.cliente)).send({ restauranteId: "r3", fecha: f, hora: "21:00", comensales: 3 });
    assert.equal(unir.status, 201);
    const otro = encodeToken({ uid: "u-otro", role: "cliente" });
    seed("usuarios", "u-otro", { uid: "u-otro", tipo: "cliente" });
    await request(app).post("/v1/espera").set(auth(otro)).send({ restauranteId: "r3", fecha: f, hora: "21:00", comensales: 2 });

    // Se cancela una reserva → hay hueco → avisa a u-cli (el primero), no a u-otro
    const cancel = await request(app).put(`/v1/reservations/${r1.body.id}/cancel`).set(auth(tokens.cliente2));
    assert.equal(cancel.status, 200);
    const aforo = aforoDe("r3", f, "21:00");
    assert.ok(aforo.retenidas["u-cli"], "plaza retenida para el primero de la cola");
    assert.equal(aforo.retenidas["u-otro"], undefined);
    const aviso = docs("mensajes").find((m) => m.uid === "u-cli" && m.tipo === "lista_espera");
    assert.ok(aviso, "mensaje de mesa libre");
    assert.match(aviso.enlace, /^#\/r\/r3\?fecha=/);

    // Para los demás sigue completo; para el avisado hay sitio
    const dispOtro = await request(app).get(`/v1/reservations/availability?restauranteId=r3&fecha=${f}&hora=21:00`).set(auth(otro));
    assert.equal(dispOtro.body.libres, 0);
    const dispMia = await request(app).get(`/v1/reservations/availability?restauranteId=r3&fecha=${f}&hora=21:00`).set(auth(tokens.cliente));
    assert.equal(dispMia.body.retenidaParaTi, true);
    assert.equal((await reservar(otro, f, "21:00")).status, 409, "otro no puede quitarle la plaza");

    const mia = await reservar(tokens.cliente, f, "21:00");
    assert.equal(mia.status, 201);
    assert.equal(Object.keys(aforoDe("r3", f, "21:00").retenidas).length, 0, "la retención se consume");
    assert.equal(docs("espera").find((e) => e.uid === "u-cli").estado, "confirmado");
  });

  test("si la retención caduca, pasa al siguiente de la cola", async () => {
    const f = manana();
    await llenar(f, "20:00");
    seed("usuarios", "u-otro", { uid: "u-otro", tipo: "cliente" });
    const otro = encodeToken({ uid: "u-otro", role: "cliente" });
    await request(app).post("/v1/espera").set(auth(tokens.cliente)).send({ restauranteId: "r3", fecha: f, hora: "20:00", comensales: 2 });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post("/v1/espera").set(auth(otro)).send({ restauranteId: "r3", fecha: f, hora: "20:00", comensales: 2 });
    seed("aforo", `r3_${f}_20:00`, { ocupadas: 3, limite: 4 }); // se libera una mesa
    assert.equal(await espera.alLiberarseMesa("r3", f, "20:00"), "u-cli");
    const n = await espera.caducarAvisos(Date.now() + espera.RETENCION_MS + 1000);
    assert.equal(n, 1);
    assert.equal(docs("espera").find((e) => e.uid === "u-cli").estado, "expirado");
    assert.ok(aforoDe("r3", f, "20:00").retenidas["u-otro"], "ahora la tiene el siguiente");
  });

  test("cancelar desde el panel también libera la plaza y avisa", async () => {
    const f = manana();
    const r1 = await reservar(tokens.cliente2, f, "13:00");
    seed("aforo", `r3_${f}_13:00`, { ocupadas: 4, limite: 4 });
    await request(app).post("/v1/espera").set(auth(tokens.cliente)).send({ restauranteId: "r3", fecha: f, hora: "13:00", comensales: 2 });
    const res = await request(app).put(`/v1/dashboard/reservations/${r1.body.id}/status`).set(auth(tokens.admin)).send({ status: "cancelada" });
    assert.equal(res.status, 200);
    assert.equal(aforoDe("r3", f, "13:00").ocupadas, 3);
    assert.ok(aforoDe("r3", f, "13:00").retenidas["u-cli"]);
  });
});

describe("reserva en grupo (JAM)", () => {
  const propuesta = () => ({
    titulo: "Cumple de Laura",
    nombre: "Laura",
    restaurantes: [{ id: "r1" }, { id: "r3" }],
    franjas: [{ fecha: manana(), hora: "21:00" }, { fecha: manana(), hora: "21:30" }],
    cierraEnMin: 60,
  });

  test("lógica: recuento y orden de intentos (más votado + franja con más gente)", () => {
    const jam = {
      restaurantes: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B" }],
      franjas: [{ fecha: "2026-10-10", hora: "21:00" }, { fecha: "2026-10-10", hora: "21:30" }],
      participantes: { u1: { restaurantes: ["b"], franjas: [1] }, u2: { restaurantes: ["a", "b"], franjas: [0, 1] }, u3: { restaurantes: [], franjas: [1] } },
    };
    const c = logica.combinaciones(jam);
    assert.deepEqual(c.slice(0, 2).map((x) => [x.restauranteId, x.hora, x.comensales]), [["b", "21:30", 3], ["b", "21:00", 1]]);
    assert.equal(c[2].restauranteId, "a");
    assert.equal(logica.generarCodigo().length, 6);
    assert.ok(logica.validarPropuesta({ restaurantes: [], franjas: [], cierraEnMin: 1 }, { slots: ["21:00"] }).length >= 3);
  });

  test("crear, unirse, votar en directo, cerrar → reserva automática y aviso a todos", async () => {
    const creada = await request(app).post("/v1/jams").set(auth(tokens.cliente)).send(propuesta());
    assert.equal(creada.status, 201);
    const { codigo } = creada.body;
    assert.match(codigo, /^[A-Z2-9]{6}$/);
    assert.equal(creada.body.soyAnfitrion, true);
    assert.ok(!JSON.stringify(creada.body).includes("u-cli"), "la vista pública no expone uids");

    const otro = encodeToken({ uid: "u-otro", role: "cliente" });
    seed("usuarios", "u-otro", { uid: "u-otro", tipo: "cliente" });
    assert.equal((await request(app).post(`/v1/jams/${codigo}/unirse`).set(auth(tokens.cliente2)).send({ nombre: "Pau" })).status, 200);
    assert.equal((await request(app).post(`/v1/jams/${codigo}/unirse`).set(auth(otro)).send({ nombre: "Marta" })).status, 200);

    // Votos: r3 gana, 21:30 es la franja con más gente
    await request(app).put(`/v1/jams/${codigo}/voto`).set(auth(tokens.cliente)).send({ restaurantes: ["r3"], franjas: [1] });
    await request(app).put(`/v1/jams/${codigo}/voto`).set(auth(tokens.cliente2)).send({ restaurantes: ["r3", "r1"], franjas: [0, 1] });
    const v = await request(app).put(`/v1/jams/${codigo}/voto`).set(auth(otro)).send({ restaurantes: [], franjas: [1] });
    assert.deepEqual(v.body.recuento.restaurantes[0], { id: "r3", votos: 2 });
    assert.deepEqual(v.body.recuento.franjas[0], { indice: 1, pueden: 3 });

    // Solo el anfitrión cierra
    assert.equal((await request(app).post(`/v1/jams/${codigo}/cerrar`).set(auth(tokens.cliente2))).status, 403);
    const cerrada = await request(app).post(`/v1/jams/${codigo}/cerrar`).set(auth(tokens.cliente));
    assert.equal(cerrada.body.estado, "reservada");
    assert.equal(cerrada.body.resultado.restauranteId, "r3");
    assert.equal(cerrada.body.resultado.hora, "21:30");
    assert.equal(cerrada.body.resultado.comensales, 3);
    const reserva = docs("reservas").find((r) => r.uid === "u-cli" && r.hora === "21:30");
    assert.ok(reserva, "la reserva existe a nombre del anfitrión");
    assert.equal(docs("mensajes").filter((m) => m.tipo === "jam").length, 3, "avisa a los 3 participantes");
    assert.equal((await request(app).put(`/v1/jams/${codigo}/voto`).set(auth(otro)).send({ restaurantes: ["r1"] })).status, 409);
  });

  test("si la ganadora está completa reserva la siguiente combinación", async () => {
    const creada = await request(app).post("/v1/jams").set(auth(tokens.cliente)).send(propuesta());
    const { codigo } = creada.body;
    await request(app).put(`/v1/jams/${codigo}/voto`).set(auth(tokens.cliente)).send({ restaurantes: ["r3"], franjas: [0] });
    await llenar(manana(), "21:00", "r3");
    const cerrada = await request(app).post(`/v1/jams/${codigo}/cerrar`).set(auth(tokens.cliente));
    assert.equal(cerrada.body.estado, "reservada");
    assert.deepEqual([cerrada.body.resultado.restauranteId, cerrada.body.resultado.hora], ["r1", "21:00"]);
    assert.equal(cerrada.body.resultado.intentos, 2);
  });

  test("se cierra sola al vencer el plazo (al abrirla o por el cron)", async () => {
    const creada = await request(app).post("/v1/jams").set(auth(tokens.cliente)).send(propuesta());
    const { codigo } = creada.body;
    const doc = store.get("jams").get(codigo);
    store.get("jams").set(codigo, { ...doc, cierraEn: new Date(Date.now() - 1000).toISOString() });
    jams._reset();
    const res = await request(app).get(`/v1/jams/${codigo}`);
    assert.equal(res.body.estado, "reservada");
    assert.equal(res.body.resultado.cerradaPor, "automatico");
  });

  test("404 para un código inexistente y validación de la propuesta", async () => {
    assert.equal((await request(app).get("/v1/jams/ZZZZZZ")).status, 404);
    const mala = await request(app).post("/v1/jams").set(auth(tokens.cliente)).send({ ...propuesta(), franjas: [{ fecha: "2020-01-01", hora: "21:00" }] });
    assert.equal(mala.status, 400);
  });
});

describe("carga en directo", () => {
  test("cuenta peticiones, latencia y errores en memoria; solo admin", async () => {
    await request(app).get("/health");
    for (let i = 0; i < 5; i++) await request(app).get("/v1/restaurants/count");
    await request(app).get("/v1/no-existe");
    assert.equal((await request(app).get("/v1/metricas/directo").set(auth(tokens.cliente))).status, 403);
    const res = await request(app).get("/v1/metricas/directo?segundos=60").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.ok(res.body.resumen.peticiones >= 6, "cuenta las peticiones (no /health ni /v1/metricas)");
    assert.ok(res.body.resumen.errores4xx >= 1);
    assert.ok(res.body.resumen.p95 != null);
    assert.equal(res.body.serie.length, 60);
    assert.ok(res.body.rutas.some((r) => r.ruta.includes("/count")));
    assert.ok(res.body.sistema.memoriaMB > 0);
    assert.equal(metricas.percentil([1, 2, 3, 4, 100], 50), 3);
  });
});
