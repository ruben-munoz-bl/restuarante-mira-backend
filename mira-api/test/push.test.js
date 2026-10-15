const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const { Expo } = require("expo-server-sdk");
const { admin, db } = require("../src/middlewares/verifyFirebaseAuth");
const request = require("supertest");
const app = require("../src/app");
const service = require("../src/modules/push/service");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const registro = { token: "ExponentPushToken[test-token]", tipo: "expo", plataforma: "android", idioma: "es" };
const aviso = { titulo: "Reserva", cuerpo: "Confirmada", data: { ruta: "reservas" } };
const dispositivos = uid => store.get(`usuarios/${uid}/dispositivos`);

// El helper común no interpreta <=. Aplicarlo aquí sin cambiar otras suites.
const collection = db.collection.bind(db);
test.beforeEach(() => {
  seedBase();
  clearRateLimits();
  db.collectionGroup = nombre => ({
    where: (campo, op, valor) => ({ get: async () => {
      assert.equal(nombre, "dispositivos");
      assert.equal(op, "==");
      const docs = [];
      for (const [ruta, documentos] of store) {
        if (ruta.split("/").at(-1) !== nombre) continue;
        for (const [id, data] of documentos) {
          if (data[campo] !== valor) continue;
          const ref = collection(ruta).doc(id);
          ref.path = `${ruta}/${id}`;
          docs.push({ id, ref, data: () => ({ ...data }) });
        }
      }
      return { docs, empty: docs.length === 0 };
    } }),
  });
  test.mock.method(db, "collection", name => {
    const col = collection(name);
    const doc = col.doc.bind(col);
    col.doc = id => Object.assign(doc(id), { path: `${name}/${id}` });
    if (name !== "push_recibos") return col;
    const where = col.where.bind(col);
    col.where = (campo, op, valor) => op !== "<=" ? where(campo, op, valor) : {
      limit: limite => ({ get: async () => {
        const snap = await col.get();
        const docs = snap.docs.filter(doc => doc.data()[campo] <= valor).slice(0, limite);
        return { docs, empty: docs.length === 0 };
      } }),
    };
    return col;
  });
});
test.afterEach(() => { test.mock.restoreAll(); delete admin.messaging; delete db.collectionGroup; });
function post(body = registro, token = tokens.cliente) {
  return request(app).post("/v1/push/tokens").set("Authorization", `Bearer ${token}`).send(body);
}

test("POST exige Bearer y valida los campos del contrato", async () => {
  assert.equal((await request(app).post("/v1/push/tokens").send(registro)).status, 401);
  assert.equal((await post(registro, tokens.invalid)).status, 401);
  for (const cambio of [{ tipo: "otro" }, { idioma: "fr" }, { plataforma: "pc" }, { token: "x" }, { token: " " }, { token: "x".repeat(4097) }, { uid: "u-cli2" }, { idioma: undefined }]) {
    assert.equal((await post({ ...registro, ...cambio })).status, 400);
  }
});
test("POST idempotente actualiza metadatos, admite FCM y no devuelve el token", async () => {
  const primero = await post();
  assert.equal(primero.status, 200);
  assert.match(primero.body.id, /^[a-f0-9]{64}$/);
  assert.equal(primero.body.token, undefined);
  const segundo = await post({ ...registro, idioma: "ca" });
  assert.equal(segundo.body.id, primero.body.id);
  assert.equal(dispositivos("u-cli").size, 1);
  assert.equal(dispositivos("u-cli").get(primero.body.id).idioma, "ca");
  assert.ok(dispositivos("u-cli").get(primero.body.id).actualizado);
  assert.equal((await post({ token: "fcm-web-token", tipo: "web", plataforma: "ios", idioma: "en" })).status, 200);
});
test("DELETE aísla usuarios incluso admin, valida ID y es idempotente", async () => {
  const { body: { id } } = await post();
  const borrar = (token, ident = id) => request(app).delete(`/v1/push/tokens/${ident}`).set("Authorization", `Bearer ${token}`);
  assert.equal((await request(app).delete(`/v1/push/tokens/${id}`)).status, 401);
  assert.equal((await borrar(tokens.invalid)).status, 401);
  assert.equal((await borrar(tokens.cliente, "invalido")).status, 400);
  for (const token of [tokens.cliente2, tokens.admin]) {
    assert.equal((await borrar(token)).status, 204);
    assert.equal(dispositivos("u-cli").size, 1);
  }
  assert.equal((await borrar(tokens.cliente)).status, 204);
  assert.equal((await borrar(tokens.cliente)).status, 204);
  assert.equal(dispositivos("u-cli").size, 0);
});
test("enviarPush entrega por cada canal solo al UID solicitado y persiste recibos", async () => {
  await service.registrarToken("u-cli", registro);
  await service.registrarToken("u-cli", { ...registro, tipo: "web", token: "fcm-web" });
  await service.registrarToken("u-cli2", { ...registro, token: "ExpoPushToken[ajeno]" });
  const expo = test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async messages => {
    assert.deepEqual(messages, [{ to: registro.token, title: aviso.titulo, body: aviso.cuerpo, data: aviso.data, sound: "default" }]);
    return [{ status: "ok", id: "recibo-1" }];
  });
  const enviados = [];
  admin.messaging = () => ({ send: async msg => { enviados.push(msg); return "ok"; } });
  assert.deepEqual(await service.enviarPush("u-cli", aviso), { enviados: 2, fallidos: 0, eliminados: 0 });
  assert.equal(expo.mock.calls.length, 1);
  assert.deepEqual(enviados, [{ token: "fcm-web", notification: { title: aviso.titulo, body: aviso.cuerpo }, data: aviso.data }]);
  assert.equal(store.get("push_recibos").get("recibo-1").uid, "u-cli");
  assert.deepEqual(await service.enviarPush("sin-dispositivos", aviso), { enviados: 0, fallidos: 0, eliminados: 0 });
  await assert.rejects(service.enviarPush("u-cli", { ...aviso, data: { numero: 1 } }));
});
test("limpia tickets y FCM desregistrados; conserva errores temporales", async () => {
  await service.registrarToken("u-cli", registro);
  for (const token of ["caducado", "invalido", "temporal"]) await service.registrarToken("u-cli", { ...registro, tipo: "web", token });
  test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async () => [{ status: "error", details: { error: "DeviceNotRegistered" } }]);
  admin.messaging = () => ({ send: async ({ token }) => {
    const codes = { caducado: "messaging/registration-token-not-registered", invalido: "messaging/invalid-registration-token", temporal: "messaging/server-unavailable" };
    throw Object.assign(new Error("proveedor"), { code: codes[token] });
  } });
  assert.deepEqual(await service.enviarPush("u-cli", aviso), { enviados: 0, fallidos: 4, eliminados: 3 });
  assert.equal(dispositivos("u-cli").size, 1);
  assert.equal([...dispositivos("u-cli").values()][0].token, "temporal");
});
test("fallo de red Expo no impide enviar al resto", async () => {
  await service.registrarToken("u-cli", registro);
  await service.registrarToken("u-cli", { ...registro, tipo: "web", token: "web" });
  test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async () => { throw new Error("red"); });
  admin.messaging = () => ({ send: async () => "ok" });
  assert.deepEqual(await service.enviarPush("u-cli", aviso), { enviados: 1, fallidos: 1, eliminados: 0 });
  assert.equal(dispositivos("u-cli").size, 2);
});
test("recibos diferidos limpian, reintentan pendientes y caducan a las 24 horas", async () => {
  const { id } = await service.registrarToken("u-cli", registro);
  const ahora = Date.now();
  for (const [recibo, creado, revisarDesde] of [["invalido", ahora, 0], ["pendiente", ahora, 0], ["viejo", ahora - 86400001, 0], ["ok", ahora, 0], ["futuro", ahora, ahora + 900000]]) {
    seed("push_recibos", recibo, { uid: "u-cli", dispositivoId: id, creado, revisarDesde });
  }
  test.mock.method(Expo.prototype, "getPushNotificationReceiptsAsync", async ids => {
    assert.equal(ids.includes("futuro"), false);
    return { invalido: { status: "error", details: { error: "DeviceNotRegistered" } }, ok: { status: "ok" } };
  });
  await service.revisarRecibos();
  assert.equal(dispositivos("u-cli").size, 0);
  assert.deepEqual([...store.get("push_recibos").keys()].sort(), ["futuro", "pendiente"]);
  assert.ok(store.get("push_recibos").get("pendiente").revisarDesde > ahora);
});
test("fallo al consultar recibos conserva los registros para reintentar", async () => {
  const { id } = await service.registrarToken("u-cli", registro);
  seed("push_recibos", "r", { uid: "u-cli", dispositivoId: id, creado: Date.now(), revisarDesde: 0 });
  test.mock.method(Expo.prototype, "getPushNotificationReceiptsAsync", async () => { throw new Error("red"); });
  await assert.rejects(service.revisarRecibos(), /red/);
  assert.equal(dispositivos("u-cli").size, 1);
  assert.equal(store.get("push_recibos").size, 1);
});


test("el token reasignado de A a B nunca se usa al notificar a A (Expo y web)", async () => {
  const expo = test.mock.method(Expo.prototype, "sendPushNotificationsAsync", async () => [{ status: "ok", id: "reasignado" }]);
  const enviadosWeb = [];
  admin.messaging = () => ({ send: async msg => { enviadosWeb.push(msg); return "ok"; } });
  for (const tipo of ["expo", "web"]) {
    const datos = { ...registro, tipo, token: tipo === "expo" ? registro.token : "fcm-compartido" };
    const a = await post(datos);
    assert.equal(a.status, 200);
    assert.equal(dispositivos("u-cli").get(a.body.id).tokenHash, a.body.id);
    const b = await post(datos, tokens.cliente2);
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
    assert.equal(dispositivos("u-cli").has(a.body.id), false);
    assert.equal(dispositivos("u-cli2").get(b.body.id).tokenHash, b.body.id);
  }
  assert.deepEqual(await service.enviarPush("u-cli", aviso), { enviados: 0, fallidos: 0, eliminados: 0 });
  assert.equal(expo.mock.calls.length, 0);
  assert.equal(enviadosWeb.length, 0);
  assert.deepEqual(await service.enviarPush("u-cli2", aviso), { enviados: 2, fallidos: 0, eliminados: 0 });
  assert.equal(expo.mock.calls.length, 1);
  assert.equal(enviadosWeb[0].token, "fcm-compartido");
});

test("el cupo de diez elimina el más antiguo y renovar uno lo conserva", async () => {
  const ids = [];
  for (let n = 0; n < 10; n++) {
    const { id } = await service.registrarToken("u-cli", { ...registro, token: `ExpoPushToken[dispositivo-${n}]` });
    ids.push(id);
    const data = dispositivos("u-cli").get(id);
    dispositivos("u-cli").set(id, { ...data, actualizado: new Date(2000, 0, n + 1).toISOString() });
  }
  assert.equal(dispositivos("u-cli").size, 10);
  await service.registrarToken("u-cli2", registro);
  // Renovar el más antiguo no expulsa ninguno y lo convierte en el más reciente.
  await service.registrarToken("u-cli", { ...registro, token: "ExpoPushToken[dispositivo-0]", idioma: "ca" });
  assert.equal(dispositivos("u-cli").size, 10);
  const nuevo = await service.registrarToken("u-cli", { ...registro, token: "ExpoPushToken[nuevo]" });
  assert.equal(dispositivos("u-cli").size, 10);
  assert.ok(dispositivos("u-cli").has(nuevo.id));
  assert.ok(dispositivos("u-cli").has(ids[0]));
  assert.equal(dispositivos("u-cli").get(ids[0]).idioma, "ca");
  assert.equal(dispositivos("u-cli").has(ids[1]), false);
  assert.equal(dispositivos("u-cli2").size, 1);
});

test("si falla la búsqueda global no confirma el registro ni deja duplicados", async () => {
  const { id } = await service.registrarToken("u-cli", registro);
  db.collectionGroup = () => ({ where: () => ({ get: async () => { throw new Error("índice no disponible"); } }) });
  await assert.rejects(service.registrarToken("u-cli2", registro), /índice no disponible/);
  assert.ok(dispositivos("u-cli").has(id));
  assert.equal(dispositivos("u-cli2")?.size || 0, 0);
});
