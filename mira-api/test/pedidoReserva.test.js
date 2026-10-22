const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const request = require("supertest");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const { hoyMadrid } = require("../src/modules/ofertas/logica");
const app = require("../src/app");
const auth = t => ({ Authorization: `Bearer ${t}` });
const base = () => ({ restauranteId: "r1", fecha: hoyMadrid(), hora: "13:00", comensales: 2 });
const pedido = { lineas: [{ platoId: "p1", cantidad: 3 }, { platoId: "p2", cantidad: 2 }] };
const crear = (extra = {}, token = tokens.cliente) => request(app).post("/v1/reservations").set(auth(token)).send({ ...base(), ...extra });
const listar = (q = "restauranteId=r1", token = tokens.empresa) => request(app).get(`/v1/reservations/restaurante?${q}`).set(auth(token));
test.beforeEach(() => {
  seedBase(); clearRateLimits();
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("cartas", "r1", { categorias: [{ id: "c", nombre: "C", platos: [
    { id: "p1", nombre: "Plato uno", precio: 0.1, disponible: true },
    { id: "p2", nombre: "Plato dos", precio: 9.99, disponible: true },
    { id: "agotado", nombre: "Agotado", precio: 2, disponible: false },
  ] }] });
});

test("reserva copia precios/nombre, calcula en céntimos y no da puntos al reservar", async () => {
  const res = await crear({ pedido }); assert.equal(res.status, 201);
  assert.deepEqual(res.body.pedido.lineas, [
    { platoId: "p1", nombre: "Plato uno", precio: 0.1, cantidad: 3, subtotal: 0.3 },
    { platoId: "p2", nombre: "Plato dos", precio: 9.99, cantidad: 2, subtotal: 19.98 },
  ]);
  assert.equal(res.body.pedido.total, 20.28); assert.equal(res.body.pedido.moneda, "EUR");
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 0);
  assert.equal(store.get("puntos_movimientos")?.size || 0, 0);
  seed("cartas", "r1", { categorias: [] });
  const list = await request(app).get("/v1/reservations").set(auth(tokens.cliente));
  assert.deepEqual(list.body.data[0].pedido, res.body.pedido);
  assert.equal(list.body.data[0].presentadaEn, null);
  const ajena = await request(app).get("/v1/reservations").set(auth(tokens.cliente2));
  assert.equal(ajena.body.data.length, 0);
});

test("reserva sin pedido conserva compatibilidad; registros antiguos se leen con null", async () => {
  store.delete("cartas"); const res = await crear();
  assert.equal(res.status, 201); assert.equal(res.body.pedido, null);
  seed("reservas", "antigua", { uid: "u-cli", restaurantId: "r1", fecha: hoyMadrid(), hora: "14:00", estado: "pendiente" });
  const list = await request(app).get("/v1/reservations").set(auth(tokens.cliente));
  assert.ok(list.body.data.every(r => r.pedido === null && r.presentadaEn === null));
});

test("rechaza plato ajeno, agotado y restaurante sin carta sin crear reserva ni ocupar aforo", async () => {
  seed("cartas", "r2", { categorias: [{ platos: [{ id: "ajeno", nombre: "Otro", precio: 1, disponible: true }] }] });
  for (const id of ["ajeno", "agotado", "ausente"]) {
    const res = await crear({ pedido: { lineas: [{ platoId: id, cantidad: 1 }] } });
    assert.equal(res.status, 400); assert.deepEqual(res.body, { error: "PLATO_NO_DISPONIBLE", platoId: id });
  }
  store.delete("cartas");
  const res = await crear({ pedido }); assert.equal(res.status, 400); assert.equal(res.body.error, "SIN_CARTA");
  assert.equal(store.get("reservas")?.size || 0, 0); assert.equal(store.get("aforo")?.size || 0, 0);
});

test("valida líneas, cantidades, duplicados e impide aportar precio/nombre/total", async () => {
  for (const invalido of [null, { lineas: [] }, { lineas: Array(31).fill({ platoId: "p1", cantidad: 1 }) },
    { lineas: [{ platoId: "p1", cantidad: 1 }, { platoId: "p1", cantidad: 2 }] },
    ...[0, 21, 1.5, "2"].map(cantidad => ({ lineas: [{ platoId: "p1", cantidad }] })),
    { lineas: [{ platoId: "p1", cantidad: 1, precio: 0.01 }] }, { lineas: [{ platoId: "p1", cantidad: 1, nombre: "Falso" }] },
    { lineas: [{ platoId: "p1", cantidad: 1 }], total: 0.01 },
  ]) assert.equal((await crear({ pedido: invalido })).status, 400);
});

test("listado del restaurante solo datos públicos, rango inclusivo y orden fecha/hora sin duplicados", async () => {
  const res = await crear({ pedido });
  seed("reservas", "antes", { uid: "u-cli", restaurantId: "r1", fecha: hoyMadrid(), hora: "12:00", estado: "pendiente", email: "privado@test.local" });
  seed("reservas", "fuera", { uid: "u-cli", restaurantId: "r1", fecha: "2000-01-01", hora: "12:00" });
  seed("reservas", "otro", { uid: "u-cli", restaurantId: "r2", fecha: hoyMadrid(), hora: "12:00" });
  const list = await listar(); assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map(r => r.id), ["antes", res.body.id]);
  assert.equal(list.body.data[1].cliente.nombre, "Cliente");
  assert.deepEqual(list.body.data[1].pedido, res.body.pedido);
  assert.equal(/"(?:uid|email|usuarioEmail|usuarioNombre|qr)":/.test(JSON.stringify(list.body)), false);
  assert.equal((await listar("restauranteId=r1&desde=2000-01-01&hasta=2000-01-01")).body.data[0].id, "fuera");
});

test("listado exige propiedad, rol, token y parámetros válidos", async () => {
  assert.equal((await request(app).get("/v1/reservations/restaurante?restauranteId=r1")).status, 401);
  assert.equal((await listar("restauranteId=r1", tokens.invalid)).status, 401);
  assert.equal((await listar("restauranteId=r1", tokens.cliente)).status, 403);
  assert.equal((await listar("restauranteId=r2")).status, 403);
  assert.equal((await listar("restauranteId=ausente", tokens.admin)).status, 404);
  assert.equal((await listar("restauranteId=r1", tokens.admin)).status, 200);
  for (const q of ["", "restauranteId=r1&desde=2026-02-30", "restauranteId=r1&desde=2026-10-22&hasta=2026-10-21",
    "restauranteId=r1&desde=2026-10-22&hasta=2026-11-23"]) assert.equal((await listar(q)).status, 400);
  assert.equal((await listar("restauranteId=r1&desde=2026-10-22&hasta=2026-11-22")).status, 200);
});

test("cancelar con pedido mantiene copia sin otorgar puntos ni ofrecer edición", async () => {
  const res = await crear({ pedido });
  assert.equal((await request(app).put(`/v1/reservations/${res.body.id}/pedido`).set(auth(tokens.cliente)).send({ pedido })).status, 404);
  assert.equal((await request(app).put(`/v1/reservations/${res.body.id}/cancel`).set(auth(tokens.cliente))).status, 200);
  const guardada = store.get("reservas").get(res.body.id);
  assert.equal(guardada.estado, "cancelada"); assert.deepEqual(guardada.pedido, res.body.pedido);
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 0);
});

test("delRestaurante exige rango en ambas consultas y no lee perfiles fuera de fecha", async () => {
  const { mockDb } = require("./helpers/mockFirebase");
  const svc = require("../src/modules/reservations/service");
  const original = mockDb.collection.bind(mockDb); const consultas = []; const perfiles = [];
  seed("reservas", "vieja", { restaurantId: "r1", fecha: "2000-01-01", uid: "u-cli2", hora: "12:00" });
  seed("reservas", "actual", { restauranteId: "r1", fecha: hoyMadrid(), uid: "u-cli", hora: "13:00" });
  test.mock.method(mockDb, "collection", nombre => {
    const col = original(nombre);
    if (nombre === "usuarios") return { ...col, doc(id) { perfiles.push(id); return col.doc(id); } };
    if (nombre !== "reservas") return col;
    const condiciones = [];
    const wrap = q => ({
      where(f, op, valor) { condiciones.push([f, op, valor]); return wrap(q.where(f, op, valor)); },
      orderBy(...args) { assert.deepEqual(args, ["fecha", "desc"]); return wrap(q.orderBy(...args)); },
      async get() {
        assert.deepEqual(condiciones.slice(1), [["fecha", ">=", hoyMadrid()], ["fecha", "<=", hoyMadrid()]]);
        consultas.push(condiciones[0]); return q.get();
      },
    }); return wrap(col);
  });
  try {
    const lista = await svc.delRestaurante("r1", hoyMadrid(), hoyMadrid());
    assert.deepEqual(lista.map(r => r.id), ["actual"]);
    assert.deepEqual(consultas, [["restaurantId", "==", "r1"], ["restauranteId", "==", "r1"]]);
    assert.deepEqual(perfiles, ["u-cli"]);
  } finally { test.mock.restoreAll(); }
});
