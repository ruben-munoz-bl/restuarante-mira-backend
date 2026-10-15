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

let enviados;
let recibo;
const reservaId = "res-push";
const auth = token => ({ Authorization: `Bearer ${token}` });
const cambiar = (status, token = tokens.empresa) => request(app)
  .put(`/v1/dashboard/reservations/${reservaId}/status`).set(auth(token)).send({ status });
const cancelar = (token = tokens.cliente) => request(app)
  .put(`/v1/reservations/${reservaId}/cancel`).set(auth(token));
function dispositivo(uid, id, tipo, idioma) {
  seed(`usuarios/${uid}/dispositivos`, id, { tipo, idioma, token: tipo === "expo" ? `ExpoPushToken[${id}]` : `fcm-${id}` });
}

test.beforeEach(() => {
  seedBase();
  clearRateLimits();
  enviados = [];
  recibo = 0;
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("reservas", reservaId, {
    uid: "u-cli", restaurantId: "r1", restauranteId: "r1", nombreRestaurante: "Casa Lucio",
    fecha: "2030-01-01", hora: "13:00", comensales: 2, estado: "pendiente",
  });
  seed("aforo", "r1_2030-01-01_13:00", { ocupadas: 1, limite: 6 });
  dispositivo("u-cli", "es", "expo", "es");
  dispositivo("u-cli", "ca", "web", "ca");
  dispositivo("u-cli", "en", "expo", "en");
  dispositivo("u-cli2", "ajeno", "web", "en");
  test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async messages => messages.map(msg => {
    enviados.push({ to: msg.to, title: msg.title, body: msg.body, data: msg.data });
    return { status: "ok", id: `recibo-${++recibo}` };
  }));
  admin.messaging = () => ({ send: async msg => {
    enviados.push({ to: msg.token, title: msg.notification.title, body: msg.notification.body, data: msg.data });
    return "ok";
  } });
});
test.afterEach(() => { test.mock.restoreAll(); delete admin.messaging; });

test("confirmar desde otra cuenta avisa al cliente en el idioma de cada token y no duplica al repetir", async () => {
  assert.equal((await cambiar("confirmada")).status, 200);
  assert.equal(store.get("reservas").get(reservaId).estado, "confirmada");
  assert.equal(enviados.length, 3);
  assert.deepEqual(enviados.map(msg => msg.to).sort(), ["ExpoPushToken[en]", "ExpoPushToken[es]", "fcm-ca"]);
  assert.match(enviados.find(msg => msg.to === "fcm-ca").body, /La teva reserva/);
  assert.equal(enviados.find(msg => msg.to === "ExpoPushToken[en]").title, "Reservation confirmed");
  assert.equal(enviados.find(msg => msg.to === "ExpoPushToken[es]").title, "Reserva confirmada");
  for (const msg of enviados) assert.deepEqual(msg.data, { ruta: "reservas", reservaId, estado: "confirmada" });
  assert.equal((await cambiar("confirmada")).status, 200);
  assert.equal(enviados.length, 3);
});

test("cancelar desde el panel notifica al cliente una sola vez y libera el aforo", async () => {
  assert.equal((await cambiar("cancelada")).status, 200);
  assert.equal(store.get("aforo").get("r1_2030-01-01_13:00").ocupadas, 0);
  assert.equal(enviados.length, 3);
  assert.equal(enviados.find(msg => msg.to === "fcm-ca").title, "Reserva cancel·lada");
  assert.equal(enviados.find(msg => msg.to === "ExpoPushToken[en]").title, "Reservation cancelled");
  assert.equal((await cambiar("cancelada")).status, 200);
  assert.equal(enviados.length, 3);
});

test("cancelación propia no avisa; cancelación de admin avisa al UID de la reserva", async () => {
  for (const token of [tokens.cliente, tokens.admin]) {
    enviados.length = 0;
    seed("reservas", reservaId, { ...store.get("reservas").get(reservaId), estado: "confirmada" });
    assert.equal((await cancelar(token)).status, 200);
    assert.equal(enviados.length, token === tokens.cliente ? 0 : 3);
    assert.ok(enviados.every(msg => msg.data.estado === "cancelada" && msg.to !== "fcm-ajeno"));
    assert.equal((await cancelar(token)).status, 409);
    assert.equal(enviados.length, token === tokens.cliente ? 0 : 3);
  }
});

test("acciones rechazadas y estados sin aviso no envían push", async () => {
  assert.equal((await cambiar("confirmada", tokens.cliente2)).status, 403);
  assert.equal((await cancelar(tokens.cliente2)).status, 403);
  assert.equal((await cambiar("pendiente")).status, 200);
  assert.equal(enviados.length, 0);
  assert.equal(store.get("reservas").get(reservaId).estado, "pendiente");
});

test("fallo de transacción no avisa; fallo de push no convierte la reserva confirmada en error", async () => {
  const transaccion = test.mock.method(db, "runTransaction", async () => { throw new Error("fallo de escritura"); });
  assert.equal((await cambiar("confirmada")).status, 500);
  assert.equal(enviados.length, 0);
  assert.equal(store.get("reservas").get(reservaId).estado, "pendiente");
  transaccion.mock.restore();
  test.mock.method(push, "enviarPush", async () => { throw new Error("proveedor no disponible"); });
  assert.equal((await cambiar("confirmada")).status, 200);
  assert.equal(store.get("reservas").get(reservaId).estado, "confirmada");
  assert.equal((await cancelar(tokens.admin)).status, 200);
  assert.equal(store.get("reservas").get(reservaId).estado, "cancelada");
});

test("mensaje interno persistido envía aviso traducido con ID sin exponer su contenido", async () => {
  const id = await enviarMensaje("u-cli", { titulo: "Asunto privado", cuerpo: "Contenido privado" });
  assert.ok(id);
  assert.equal(store.get("mensajes").get(id).cuerpo, "Contenido privado");
  assert.equal(enviados.length, 3);
  assert.deepEqual(enviados.map(msg => msg.title).sort(), ["Missatge nou", "New message", "Nuevo mensaje"].sort());
  for (const msg of enviados) {
    assert.deepEqual(msg.data, { ruta: "mensajes", mensajeId: id });
    assert.equal(msg.body.includes("Contenido privado"), false);
  }
});

test("mensaje del admin al dueño también notifica después de guardar", async () => {
  dispositivo("u-emp", "dueno", "web", "en");
  const res = await request(app).post("/v1/dashboard/restaurant/r1/message")
    .set(auth(tokens.admin)).send({ asunto: "Aviso", mensaje: "Revisar datos" });
  assert.equal(res.status, 201);
  assert.equal(store.get("mensajes").get(res.body.id).uid, "u-emp");
  assert.deepEqual(enviados, [{ to: "fcm-dueno", title: "New message", body: "You have a new message in your MIRA inbox.", data: { ruta: "mensajes", mensajeId: res.body.id } }]);
});

test("dueño sin UID conserva mensaje por email sin intentar push", async () => {
  seed("restaurants", "sin-uid", { nombre: "Local", email: "dueno@example.test" });
  const res = await request(app).post("/v1/dashboard/restaurant/sin-uid/message")
    .set(auth(tokens.admin)).send({ mensaje: "Revisar datos" });
  assert.equal(res.status, 201);
  assert.equal(res.body.uidDueno, null);
  assert.equal(store.get("mensajes").get(res.body.id).emailDueno, "dueno@example.test");
  assert.equal(enviados.length, 0);
});

test("fallo de push conserva el mensaje y su ID; fallo al guardar no avisa", async () => {
  const llamada = test.mock.method(push, "enviarPush", async () => { throw new Error("red"); });
  const id = await enviarMensaje("u-cli", { titulo: "Asunto", cuerpo: "Texto" });
  assert.ok(store.get("mensajes").has(id));
  assert.equal(llamada.mock.calls.length, 1);
  const original = db.collection.bind(db);
  test.mock.method(db, "collection", name => {
    const col = original(name);
    if (name === "mensajes") col.add = async () => { throw new Error("escritura"); };
    return col;
  });
  assert.equal(await enviarMensaje("u-cli", { titulo: "Asunto", cuerpo: "Texto" }), null);
  assert.equal(llamada.mock.calls.length, 1);
});

test("enviarPush conserva el formato original y usa texto base si falta traducción", async () => {
  const base = { titulo: "Base", cuerpo: "Texto", textos: { ca: { titulo: "Català", cuerpo: "Text" } } };
  await push.enviarPush("u-cli", base);
  assert.equal(enviados.find(msg => msg.to === "fcm-ca").title, "Català");
  assert.equal(enviados.find(msg => msg.to === "ExpoPushToken[en]").title, "Base");
  assert.equal(enviados.find(msg => msg.to === "ExpoPushToken[es]").title, "Base");
});

test("reintento del callback de Firestore no repite los avisos de confirmación ni cancelación", async () => {
  const original = db.runTransaction.bind(db);
  test.mock.method(db, "runTransaction", async callback => {
    // Primer intento descartado: lecturas reales, escrituras sin confirmar.
    await callback({ get: ref => ref.get(), update() {}, set() {}, delete() {} });
    return original(callback);
  });
  assert.equal((await cambiar("confirmada")).status, 200);
  assert.equal(enviados.length, 3);
  assert.equal((await cancelar(tokens.admin)).status, 200);
  assert.equal(enviados.length, 6);
});

test("crear una reserva pendiente todavía no anuncia una confirmación", async () => {
  const res = await request(app).post("/v1/reservations").set(auth(tokens.cliente))
    .send({ restaurantId: "r1", fecha: "2030-01-02", hora: "13:00", comensales: 2 });
  assert.equal(res.status, 201);
  assert.equal(store.get("reservas").get(res.body.id).estado, "pendiente");
  assert.equal(enviados.length, 0);
});
