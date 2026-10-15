const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const { Expo } = require("expo-server-sdk");
const { admin, db } = require("../src/middlewares/verifyFirebaseAuth");
const app = require("../src/app");
const push = require("../src/modules/push/service");
const { enviarMensaje } = require("../src/modules/mensajes/notificar");
const { clearRateLimits } = require("../src/middlewares/rateLimit");

const ruta = "/v1/push/preferencias";
const porDefecto = { reservas: true, mensajes: true, promociones: true };
const auth = token => ({ Authorization: `Bearer ${token}` });
const leer = (token = tokens.cliente) => request(app).get(ruta).set(auth(token));
const guardar = (body, token = tokens.cliente) => request(app).put(ruta).set(auth(token)).send(body);
const aviso = tipo => ({ tipo, titulo: "MIRA", cuerpo: "Aviso", data: { ruta: tipo } });
const cero = { enviados: 0, fallidos: 0, eliminados: 0 };
let enviados;
let recibo;

test.beforeEach(() => {
  seedBase();
  clearRateLimits();
  enviados = [];
  recibo = 0;
  seed("usuarios/u-cli/dispositivos", "expo", { tipo: "expo", idioma: "en", token: "ExpoPushToken[preferencias]" });
  seed("usuarios/u-cli/dispositivos", "web", { tipo: "web", idioma: "ca", token: "fcm-preferencias" });
  test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async mensajes => mensajes.map(msg => {
    enviados.push(msg);
    return { status: "ok", id: `pref-${++recibo}` };
  }));
  admin.messaging = () => ({ send: async msg => { enviados.push(msg); return "ok"; } });
});
test.afterEach(() => { test.mock.restoreAll(); delete admin.messaging; });

test("GET/PUT preferencias requieren Bearer válido", async () => {
  for (const method of ["get", "put"]) {
    const sin = request(app)[method](ruta);
    const mal = request(app)[method](ruta).set(auth(tokens.invalid));
    if (method === "put") { sin.send({ mensajes: false }); mal.send({ mensajes: false }); }
    assert.equal((await sin).status, 401);
    assert.equal((await mal).status, 401);
  }
});

test("GET devuelve valores por defecto sin crear ni modificar perfiles", async () => {
  const perfil = { ...store.get("usuarios").get("u-cli") };
  assert.deepEqual((await leer()).body, porDefecto);
  assert.deepEqual(store.get("usuarios").get("u-cli"), perfil);
  seed("usuarios", "u-cli", { ...perfil, preferenciasPush: { promociones: false } });
  assert.deepEqual((await leer()).body, { ...porDefecto, promociones: false });
  assert.deepEqual(store.get("usuarios").get("u-cli").preferenciasPush, { promociones: false });
  store.get("usuarios").delete("u-cli");
  assert.deepEqual((await leer()).body, porDefecto);
  assert.equal(store.get("usuarios").has("u-cli"), false);
});

test("PUT combina cambios parciales, conserva perfil y es idempotente", async () => {
  const perfil = { ...store.get("usuarios").get("u-cli") };
  const esperado = { reservas: true, mensajes: true, promociones: false };
  const primera = await guardar({ promociones: false });
  assert.equal(primera.status, 200);
  assert.deepEqual(primera.body, esperado);
  assert.deepEqual((await guardar({ promociones: false })).body, esperado);
  assert.deepEqual(store.get("usuarios").get("u-cli"), { ...perfil, preferenciasPush: esperado });
  assert.deepEqual((await guardar({ mensajes: false })).body, { ...esperado, mensajes: false });
  assert.deepEqual((await leer()).body, { ...esperado, mensajes: false });
});

test("PUT crea únicamente las preferencias cuando falta el perfil", async () => {
  store.get("usuarios").delete("u-cli");
  const res = await guardar({ reservas: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...porDefecto, reservas: false });
  assert.deepEqual(store.get("usuarios").get("u-cli"), { preferenciasPush: res.body });
});

test("cambios simultáneos de interruptores diferentes no se pisan", async () => {
  const respuestas = await Promise.all([guardar({ reservas: false }), guardar({ promociones: false })]);
  assert.ok(respuestas.every(res => res.status === 200));
  assert.deepEqual((await leer()).body, { reservas: false, mensajes: true, promociones: false });
});

test("rechaza body vacío, campos ajenos y valores que no son booleanos sin escribir", async () => {
  const perfil = { ...store.get("usuarios").get("u-cli") };
  for (const body of [{}, [], { promociones: "false" }, { reservas: 0 }, { mensajes: null }, { sistema: false }, { uid: "u-cli2", mensajes: false }, { preferenciasPush: { mensajes: false } }]) {
    const res = await guardar(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "VALIDATION_ERROR");
  }
  assert.deepEqual(store.get("usuarios").get("u-cli"), perfil);
});

test("solo modifica el UID autenticado, también para admin", async () => {
  await guardar({ promociones: false });
  assert.deepEqual((await leer(tokens.cliente2)).body, porDefecto);
  await guardar({ reservas: false }, tokens.admin);
  assert.deepEqual((await leer()).body, { ...porDefecto, promociones: false });
  assert.deepEqual((await leer(tokens.admin)).body, { ...porDefecto, reservas: false });
  assert.deepEqual((await request(app).get(`${ruta}?uid=u-admin`).set(auth(tokens.cliente))).body, { ...porDefecto, promociones: false });
});

test("desactivar promociones no consulta dispositivos ni envía, y conserva otras categorías", async () => {
  await guardar({ promociones: false });
  const original = db.collection.bind(db);
  const consulta = test.mock.method(db, "collection", nombre => {
    assert.notEqual(nombre, "usuarios/u-cli/dispositivos");
    return original(nombre);
  });
  assert.deepEqual(await push.enviarPush("u-cli", aviso("promociones")), cero);
  assert.equal(enviados.length, 0);
  consulta.mock.restore();
  for (const tipo of ["reservas", "mensajes"]) {
    assert.deepEqual(await push.enviarPush("u-cli", aviso(tipo)), { enviados: 2, fallidos: 0, eliminados: 0 });
  }
  assert.equal(enviados.length, 4);
  assert.equal(store.get("usuarios/u-cli/dispositivos").size, 2);
});

test("T05 etiqueta reservas/mensajes y respeta preferencias sin impedir el negocio", async () => {
  await guardar({ reservas: false });
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("reservas", "res-preferencias", { uid: "u-cli", restaurantId: "r1", estado: "pendiente" });
  const res = await request(app).put("/v1/dashboard/reservations/res-preferencias/status")
    .set(auth(tokens.empresa)).send({ status: "confirmada" });
  assert.equal(res.status, 200);
  assert.equal(store.get("reservas").get("res-preferencias").estado, "confirmada");
  assert.equal(enviados.length, 0);
  const id = await enviarMensaje("u-cli", { titulo: "Asunto", cuerpo: "Texto" });
  assert.ok(store.get("mensajes").has(id));
  assert.equal(enviados.length, 2);
  await guardar({ mensajes: false });
  const silenciado = await enviarMensaje("u-cli", { titulo: "Otro", cuerpo: "Texto" });
  assert.ok(store.get("mensajes").has(silenciado));
  assert.equal(enviados.length, 2);
});

test("reactivar se aplica al siguiente envío, sin borrar tokens ni silenciar otro UID", async () => {
  await guardar({ promociones: false });
  assert.deepEqual(await push.enviarPush("u-cli", aviso("promociones")), cero);
  seed("usuarios/u-cli2/dispositivos", "otro", { tipo: "web", token: "fcm-otro", idioma: "es" });
  assert.equal((await push.enviarPush("u-cli2", aviso("promociones"))).enviados, 1);
  await guardar({ promociones: true });
  assert.equal((await push.enviarPush("u-cli", aviso("promociones"))).enviados, 2);
  assert.equal(store.get("usuarios/u-cli/dispositivos").size, 2);
});

test("enviarPush exige un tipo conocido, sin inferirlo desde data.ruta", async () => {
  for (const tipo of [undefined, "expo", "desconocido"]) {
    await assert.rejects(push.enviarPush("u-cli", aviso(tipo)));
  }
  assert.equal(enviados.length, 0);
});

test("fallo al leer preferencias no envía y el buzón conserva los mensajes", async () => {
  const original = db.collection.bind(db);
  test.mock.method(db, "collection", nombre => {
    const col = original(nombre);
    if (nombre === "usuarios") {
      const doc = col.doc.bind(col);
      col.doc = id => ({ ...doc(id), get: async () => { throw new Error("lectura no disponible"); } });
    }
    return col;
  });
  await assert.rejects(push.enviarPush("u-cli", aviso("mensajes")), /lectura no disponible/);
  const id = await enviarMensaje("u-cli", { titulo: "Asunto", cuerpo: "Texto" });
  assert.ok(store.get("mensajes").has(id));
  assert.equal(enviados.length, 0);
});
