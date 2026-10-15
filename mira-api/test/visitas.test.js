const test = require("node:test");
const assert = require("node:assert/strict");
// Solo fixture de tests, no una credencial de despliegue.
process.env.VISITAS_SECRET = "fixture-visitas-solo-para-tests-32-caracteres";
const { seedBase, seed, store, tokens, encodeToken } = require("./helpers/mockFirebase");
const request = require("supertest");
const { db } = require("../src/middlewares/verifyFirebaseAuth");
const { env } = require("../src/config/env");
const { logger } = require("../src/middlewares/errorHandler");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const { hoyMadrid } = require("../src/modules/ofertas/logica");
const { firmarQr, leerQr, DURACION_MS } = require("../src/modules/visitas/logica");
const { crear: crearOferta } = require("../src/modules/ofertas/service");
const app = require("../src/app");
const SECRET = env.VISITAS_SECRET;
const otraEmpresa = encodeToken({ uid: "u-otra", email: "otra@example.test" });
const auth = token => ({ Authorization: `Bearer ${token}` });
const posicion = { lat: 40.4, lng: -3.7 };
const alNorte = m => ({ lat: posicion.lat + m / 6371000 * 180 / Math.PI, lng: posicion.lng });
const crear = (body = { restauranteId: "r1", ...posicion }, token = tokens.cliente) => request(app).post("/v1/visitas").set(auth(token)).send(body);
const validar = (qr, token = tokens.empresa) => request(app).post("/v1/visitas/validar").set(auth(token)).send({ qr });
const obtener = (id, token = tokens.cliente) => request(app).get(`/v1/visitas/${id}`).set(auth(token));
const listar = (query = `restauranteId=r1&fecha=${hoyMadrid()}`, token = tokens.empresa) => request(app).get(`/v1/visitas/restaurante?${query}`).set(auth(token));
const stats = (fecha = hoyMadrid()) => store.get("ofertas_stats").get(`r1_${fecha}`);
let oferta;

test.beforeEach(async () => {
  seedBase();
  clearRateLimits();
  env.VISITAS_SECRET = SECRET;
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp", comisionPct: 8 });
  seed("usuarios", "u-otra", { tipo: "empresa", nombre: "Otra empresa" });
  oferta = await crearOferta({ restauranteId: "r1", titulo: "Menú", activa: true,
    niveles: [1000, 500, 100, 20].map((distancia, i) => ({ distancia, texto: `Nivel ${distancia}`, descuentoPct: (i + 1) * 5 })),
  });
});
test.afterEach(() => { test.mock.restoreAll(); env.VISITAS_SECRET = SECRET; });

function sinUid(data) {
  if (!data || typeof data !== "object") return;
  assert.equal(Object.hasOwn(data, "uid"), false);
  for (const value of Object.values(data)) sinUid(value);
}

test("QR puro: formato firmado, lectura válida y firma manipulada", () => {
  const qr = firmarQr("vis-test", Date.now() + DURACION_MS, SECRET);
  assert.match(qr, /^v1\.vis-test\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(leerQr(qr, SECRET).visitaId, "vis-test");
  const partes = qr.split(".");
  partes[1] = "otra-visita";
  assert.throws(() => leerQr(partes.join("."), SECRET), err => err.code === "QR_INVALIDO");
  assert.throws(() => leerQr(qr.replace("v1.", "v2."), SECRET), err => err.code === "QR_INVALIDO");
});

test("crea a menos de 50 m, copia la llegada, caduca en 15 min y no devuelve UID", async () => {
  const res = await crear({ restauranteId: "r1", ...alNorte(49.9) });
  assert.equal(res.status, 201);
  assert.equal(res.body.visita.estado, "pendiente");
  assert.equal(res.body.visita.nivel.distancia, 20);
  assert.equal(Date.parse(res.body.visita.caducaEn) - Date.parse(res.body.visita.creada), DURACION_MS);
  assert.equal(res.body.visita.comisionPct, null);
  assert.equal(leerQr(res.body.qr, SECRET).visitaId, res.body.visita.id);
  assert.equal(stats().visitas, 1);
  sinUid(res.body);
});

test("cliente lejos: 422 LEJOS usa la distancia real sin redondear el umbral", async () => {
  const res = await crear({ restauranteId: "r1", ...alNorte(50.4) });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: "LEJOS", distanciaM: 50 });
  assert.equal(store.get("visitas")?.size || 0, 0);
  assert.equal(store.get("ofertas_stats")?.size || 0, 0);
});

test("rechaza falta de oferta vigente, restaurante inexistente y coordenadas ausentes", async () => {
  const datos = store.get("ofertas").get(oferta.id);
  for (const cambio of [{ activa: false }, { hasta: "2020-01-01" }, { desde: "2090-01-01" }]) {
    seed("ofertas", oferta.id, { ...datos, ...cambio });
    assert.equal((await crear()).status, 404);
  }
  seed("ofertas", oferta.id, datos);
  seed("restaurants", "r1", { nombre: "Sin coordenadas" });
  assert.equal((await crear()).status, 404);
  seed("restaurants", "r1", { coordenadas: { latitud: null, longitud: null } });
  assert.equal((await crear()).status, 404);
  assert.equal((await crear({ restauranteId: "no-existe", ...posicion })).status, 404);
});

test("crear exige cliente, Bearer válido y body estricto", async () => {
  assert.equal((await request(app).post("/v1/visitas").send({ restauranteId: "r1", ...posicion })).status, 401);
  for (const token of [tokens.empresa, tokens.admin]) assert.equal((await crear(undefined, token)).status, 403);
  assert.equal((await crear(undefined, tokens.invalid)).status, 401);
  for (const body of [{ restauranteId: "r1", lat: 91, lng: 0 }, { restauranteId: "r1", lat: "40.4", lng: -3.7 }, { restauranteId: "r1", ...posicion, uid: "u-cli2" }, { ...posicion }]) {
    assert.equal((await crear(body)).status, 400);
  }
});

test("dos creaciones simultáneas reutilizan la misma pendiente y cuentan una visita", async () => {
  const [a, b] = await Promise.all([crear(), crear()]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.visita.id, b.body.visita.id);
  assert.equal(a.body.qr, b.body.qr);
  assert.equal(store.get("visitas").size, 1);
  assert.equal(stats().visitas, 1);
  assert.equal(store.get("visitas_pendientes").size, 1);
});

test("reemitir la pendiente mantiene caducidad original y la copia del nivel", async () => {
  const a = await crear();
  const ahora = Date.now();
  test.mock.method(Date, "now", () => ahora + 3000);
  const editada = store.get("ofertas").get(oferta.id);
  editada.niveles[3] = { distancia: 20, texto: "Oferta cambiada", descuentoPct: 30 };
  seed("ofertas", oferta.id, editada);
  const b = await crear();
  assert.equal(b.status, 201);
  assert.deepEqual(b.body, a.body);
  assert.equal(stats().visitas, 1);
});

test("pendiente caducada: GET la proyecta caducada y crear abre otra sin reutilizar su QR", async () => {
  const a = await crear();
  test.mock.method(Date, "now", () => Date.parse(a.body.visita.caducaEn));
  assert.equal((await obtener(a.body.visita.id)).body.estado, "caducada");
  const b = await crear();
  assert.equal(b.status, 201);
  assert.notEqual(b.body.visita.id, a.body.visita.id);
  assert.equal(store.get("visitas").get(a.body.visita.id).estado, "caducada");
  assert.equal(stats().visitas, 2);
  assert.equal((await validar(a.body.qr)).status, 410);
});

test("GET visita solo permite a su cliente, sin excepción para admin", async () => {
  const { body: { visita } } = await crear();
  assert.equal((await obtener(visita.id)).status, 200);
  sinUid((await obtener(visita.id)).body);
  for (const token of [tokens.cliente2, tokens.admin]) assert.equal((await obtener(visita.id, token)).status, 403);
  assert.equal((await request(app).get(`/v1/visitas/${visita.id}`)).status, 401);
  assert.equal((await obtener("inexistente")).status, 404);
});

test("validar respeta firma, caducidad, existencia, dueño y pendiente en ese orden", async () => {
  const { body: { visita, qr } } = await crear();
  const caducado = firmarQr("inexistente", Date.now() - 1, SECRET);
  assert.equal((await validar(caducado)).body.error, "QR_CADUCADO");
  const manipulado = caducado.slice(0, -2) + (caducado.at(-2) === "a" ? "b" : "a") + caducado.at(-1);
  assert.equal((await validar(manipulado)).body.error, "QR_INVALIDO");
  assert.equal((await validar(firmarQr("inexistente", Date.now() + DURACION_MS, SECRET))).status, 404);
  assert.equal((await validar(qr, otraEmpresa)).body.error, "OTRO_RESTAURANTE");
  assert.equal(store.get("visitas").get(visita.id).estado, "pendiente");
  assert.equal((await validar(qr)).status, 200);
  assert.equal((await validar(qr, otraEmpresa)).status, 403, "dueño se comprueba antes que usado");
  const usado = await validar(qr);
  assert.equal(usado.status, 409);
  assert.equal(usado.body.error, "QR_USADO");
});

test("confirmar copia comisión actual, devuelve solo nombre y mantiene la copia de la oferta", async () => {
  const a = await crear();
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), comisionPct: 0 });
  const res = await validar(a.body.qr);
  assert.equal(res.status, 200);
  assert.equal(res.body.visita.comisionPct, 0, "cero no debe sustituirse por el fallback");
  assert.equal(res.body.visita.estado, "confirmada");
  assert.ok(res.body.visita.confirmadaEn);
  assert.deepEqual(res.body.aplicar, { texto: "Nivel 20", descuentoPct: 20 });
  assert.deepEqual(res.body.cliente, { nombre: "Cliente" });
  assert.equal((await obtener(a.body.visita.id)).body.estado, "confirmada");
  assert.equal(stats().confirmadas, 1);
  assert.equal(store.get("visitas_pendientes").size, 0);
  sinUid(res.body);
  const siguiente = await crear();
  assert.equal(siguiente.status, 201);
  assert.notEqual(siguiente.body.visita.id, a.body.visita.id);
  assert.equal(stats().visitas, 2);
});

test("dos validaciones simultáneas solo confirman e incrementan una vez", async () => {
  const a = await crear();
  const respuestas = await Promise.all([validar(a.body.qr), validar(a.body.qr)]);
  assert.deepEqual(respuestas.map(res => res.status).sort(), [200, 409]);
  assert.equal(stats().confirmadas, 1);
  assert.equal(stats().visitas, 1);
});

test("QR caducado al esperar la transacción no se confirma", async () => {
  const a = await crear();
  const original = db.runTransaction.bind(db);
  test.mock.method(db, "runTransaction", async callback => {
    test.mock.method(Date, "now", () => Date.parse(a.body.visita.caducaEn));
    return original(callback);
  });
  assert.equal((await validar(a.body.qr)).status, 410);
  assert.equal(store.get("visitas").get(a.body.visita.id).estado, "pendiente");
  assert.equal(stats().confirmadas, undefined);
});

test("firma válida debe coincidir con la caducidad persistida de esa visita", async () => {
  const a = await crear();
  const qr = firmarQr(a.body.visita.id, Date.parse(a.body.visita.caducaEn) + 1000, SECRET);
  const res = await validar(qr);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "QR_INVALIDO");
});

test("validar exige empresa/admin y el formato no incluye UID del cliente", async () => {
  const a = await crear();
  assert.equal((await validar(a.body.qr, tokens.cliente)).status, 403);
  assert.equal((await request(app).post("/v1/visitas/validar").send({ qr: a.body.qr })).status, 401);
  assert.equal((await validar("v1.mal" )).body.error, "QR_INVALIDO");
  assert.equal(a.body.qr.includes("u-cli"), false);
  assert.equal((await validar(a.body.qr, tokens.admin)).status, 200);
});

test("estadísticas incrementan sin sobrescribir avisos ni contadores anteriores", async () => {
  seed("ofertas_stats", `r1_${hoyMadrid()}`, { restauranteId: "r1", fecha: hoyMadrid(), visitas: 7, confirmadas: 3, avisos: { 1000: 5, 500: 2 } });
  const a = await crear();
  assert.equal(stats().visitas, 8);
  assert.equal(stats().confirmadas, 3);
  assert.equal((await validar(a.body.qr)).status, 200);
  assert.equal(stats().visitas, 8);
  assert.equal(stats().confirmadas, 4);
  assert.deepEqual(stats().avisos, { 1000: 5, 500: 2 });
  assert.deepEqual(Object.keys(stats()).sort(), ["avisos", "confirmadas", "fecha", "restauranteId", "visitas"]);
});

test("reintento de callback no crea visitas ni estadísticas dobles", async () => {
  const original = db.runTransaction.bind(db);
  test.mock.method(db, "runTransaction", async callback => {
    await callback({ get: ref => ref.get(), set() {}, update() {}, delete() {} });
    return original(callback);
  });
  const a = await crear();
  assert.equal(a.status, 201);
  assert.equal(stats().visitas, 1);
  assert.equal((await validar(a.body.qr)).status, 200);
  assert.equal(stats().confirmadas, 1);
  assert.equal(store.get("visitas").size, 1);
});

test("lista del día filtra restaurante/fecha, ordena y oculta UID/email", async () => {
  const a = await crear();
  const siguiente = Date.now() + 1000;
  test.mock.method(Date, "now", () => siguiente);
  const b = await crear(undefined, tokens.cliente2);
  const res = await listar();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map(v => v.id), [b.body.visita.id, a.body.visita.id]);
  assert.deepEqual(res.body.data[0].cliente, { nombre: "Cliente2" });
  sinUid(res.body);
  assert.equal(JSON.stringify(res.body).includes("@"), false);
  assert.deepEqual((await listar("restauranteId=r1&fecha=2000-01-01")).body.data, []);
  assert.equal((await listar("restauranteId=r1", tokens.admin)).status, 200);
  assert.equal((await listar(undefined, otraEmpresa)).status, 403);
  assert.equal((await listar(undefined, tokens.cliente)).status, 403);
  assert.equal((await listar("restauranteId=r1&fecha=2026-02-30")).status, 400);
  assert.equal((await listar("restauranteId=no-existe")).status, 404);
});

test("no guarda ni registra la posición en visitas, bloqueos, estadísticas o logs", async () => {
  const logs = [];
  for (const nivel of ["info", "warn", "error"]) test.mock.method(logger, nivel, (...args) => logs.push(args));
  const accessLog = require("../src/middlewares/accessLog");
  const previo = process.env.LOGS_ENABLED;
  process.env.LOGS_ENABLED = "true";
  accessLog._reset();
  try {
    const p = { lat: 40.40012345, lng: -3.70023456 };
    const res = await crear({ restauranteId: "r1", ...p });
    assert.equal(res.status, 201);
    await new Promise(resolve => setImmediate(resolve));
    await accessLog.flushLogs();
    const datos = JSON.stringify(["visitas", "visitas_pendientes", "ofertas_stats", "logs"].map(c => [...(store.get(c)?.values() || [])]));
    const registros = JSON.stringify(logs);
    for (const value of Object.values(p)) {
      assert.equal(datos.includes(String(value)), false);
      assert.equal(registros.includes(String(value)), false);
    }
    for (const d of store.get("visitas").values()) for (const key of ["lat", "lng", "coordenadas", "distanciaM"]) assert.equal(Object.hasOwn(d, key), false);
  } finally {
    if (previo === undefined) delete process.env.LOGS_ENABLED;
    else process.env.LOGS_ENABLED = previo;
    accessLog._reset();
  }
});

test("sin VISITAS_SECRET no firma ni valida y no se crea la visita", async () => {
  env.VISITAS_SECRET = "";
  const res = await crear();
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "VISITAS_NO_CONFIGURADO");
  assert.equal(store.get("visitas")?.size || 0, 0);
  assert.equal((await validar("qr" )).status, 503);
});


test("nombre de cliente inválido no permite devolver objetos con UID/email del perfil", async () => {
  const a = await crear();
  seed("usuarios", "u-cli", { tipo: "cliente", nombre: { uid: "u-cli", email: "privado@example.test" } });
  const res = await validar(a.body.qr);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.cliente, { nombre: "" });
  sinUid(res.body);
  const lista = await listar();
  assert.deepEqual(lista.body.data[0].cliente, { nombre: "" });
  sinUid(lista.body);
});
