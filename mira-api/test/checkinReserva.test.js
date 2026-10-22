const test = require("node:test");
const assert = require("node:assert/strict");
process.env.RESERVAS_QR_SECRET = "fixture-reservas-solo-para-tests-32-caracteres";
const { seedBase, seed, store, tokens, encodeToken } = require("./helpers/mockFirebase");
const request = require("supertest");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const { env } = require("../src/config/env");
const { hoyMadrid } = require("../src/modules/ofertas/logica");
const { firmarQrReserva, leerQrReserva } = require("../src/modules/reservations/checkin");
const app = require("../src/app");
const auth = t => ({ Authorization: `Bearer ${t}` });
const SECRET = env.RESERVAS_QR_SECRET, VISITAS = env.VISITAS_SECRET;
const pedido = { lineas: [{ platoId: "p", nombre: "Plato", precio: 2.5, cantidad: 2, subtotal: 5 }], total: 5, moneda: "EUR", creadoEn: "2026-10-22T10:00:00.000Z" };
const scan = (qr = firmarQrReserva("res1"), token = tokens.empresa) => request(app).post("/v1/reservations/checkin").set(auth(token)).send({ qr });
const lista = () => request(app).get("/v1/reservations").set(auth(tokens.cliente));
test.beforeEach(() => {
  seedBase(); clearRateLimits(); env.RESERVAS_QR_SECRET = SECRET;
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("reservas", "res1", { uid: "u-cli", restaurantId: "r1", codigo: "MIRA-TEST", fecha: hoyMadrid(), hora: "13:00", comensales: 2,
    estado: "confirmada", pedido, presentadaEn: null, puntosGenerados: 100 });
});
test.afterEach(() => { env.RESERVAS_QR_SECRET = SECRET; env.VISITAS_SECRET = VISITAS; test.mock.restoreAll(); });

test("QR r1 firmado, canónico, distinto de v1 y resistente a manipulación", () => {
  const qr = firmarQrReserva("res1"); assert.match(qr, /^r1\.res1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(leerQrReserva(qr), "res1");
  for (const invalido of [qr.replace("res1", "res2"), qr.replace("r1.", "v1."), qr + "=", "r1.res1.firma", "MIRA-TEST"]) {
    assert.throws(() => leerQrReserva(invalido), e => e.code === "QR_INVALIDO");
  }
});

test("check-in con pedido suma exactamente 50, movimiento único y estado/ticket anteriores intactos", async () => {
  const res = await scan(); assert.equal(res.status, 200); assert.equal(res.body.puntosPedido, 50);
  assert.equal(res.body.cliente.nombre, "Cliente"); assert.deepEqual(res.body.reserva.pedido, pedido);
  assert.ok(Date.parse(res.body.reserva.presentadaEn));
  assert.equal(/"(?:uid|email|usuarioEmail|usuarioNombre)":/.test(JSON.stringify(res.body)), false);
  const user = store.get("usuarios").get("u-cli"); assert.equal(user.saldoPuntos, 50); assert.equal(user.totalAcumulado, 50);
  const reserva = store.get("reservas").get("res1"); assert.equal(reserva.estado, "confirmada");
  assert.equal(reserva.puntosGenerados, 100); assert.equal(reserva.puntosPedido, 50);
  const movimientos = [...store.get("puntos_movimientos").values()];
  assert.equal(movimientos.length, 1); assert.equal(movimientos[0].tipo, "pedido_anticipado"); assert.equal(movimientos[0].puntos, 50);
  assert.equal((await scan()).body.error, "QR_USADO");
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 50);
});

test("escaneos simultáneos: un 200, resto 409; saldo y movimiento una sola vez", async () => {
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => scan()));
  assert.equal(respuestas.filter(r => r.status === 200).length, 1);
  assert.equal(respuestas.filter(r => r.status === 409 && r.body.error === "QR_USADO").length, 4);
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 50);
  assert.equal(store.get("puntos_movimientos").size, 1);
});

test("sin pedido y reserva antigua: marca llegada sin puntos ni movimientos", async () => {
  const r = { ...store.get("reservas").get("res1") }; delete r.pedido; delete r.presentadaEn; seed("reservas", "res1", r);
  const res = await scan(); assert.equal(res.status, 200); assert.equal(res.body.puntosPedido, 0); assert.equal(res.body.reserva.pedido, null);
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 0); assert.equal(store.get("puntos_movimientos")?.size || 0, 0);
});

test("permisos: sin token, inválido, cliente y otra empresa; admin puede validar", async () => {
  const qr = firmarQrReserva("res1");
  assert.equal((await request(app).post("/v1/reservations/checkin").send({ qr })).status, 401);
  assert.equal((await scan(qr, tokens.invalid)).status, 401); assert.equal((await scan(qr, tokens.cliente)).status, 403);
  seed("usuarios", "otra", { tipo: "empresa" });
  const ajeno = await scan(qr, encodeToken({ uid: "otra" })); assert.equal(ajeno.status, 403); assert.equal(ajeno.body.error, "OTRO_RESTAURANTE");
  assert.equal(store.get("reservas").get("res1").presentadaEn, null);
  assert.equal((await scan(qr, tokens.admin)).status, 200);
});

test("firma inválida, reserva ausente, cancelada y fuera de fecha no modifican saldo", async () => {
  assert.equal((await scan("MIRA-TEST")).body.error, "QR_INVALIDO");
  assert.equal((await scan(firmarQrReserva("ausente"))).status, 404);
  const r = store.get("reservas").get("res1");
  seed("reservas", "res1", { ...r, estado: "cancelada" });
  const cancelada = await scan(); assert.equal(cancelada.status, 409); assert.equal(cancelada.body.error, "RESERVA_CANCELADA");
  for (const fecha of ["2000-01-01", "2099-01-01"]) {
    seed("reservas", "res1", { ...r, fecha }); const res = await scan(); assert.equal(res.status, 409); assert.equal(res.body.error, "FUERA_DE_FECHA");
  }
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 0);
});

test("día Madrid se evalúa dentro de la transacción, también después de medianoche local", async () => {
  const RealDate = Date, fixed = new RealDate("2026-10-22T22:30:00Z");
  test.mock.method(global, "Date", class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed.getTime(); } });
  const r = store.get("reservas").get("res1");
  seed("reservas", "res1", { ...r, fecha: "2026-10-22" }); assert.equal((await scan()).body.error, "FUERA_DE_FECHA");
  seed("reservas", "res1", { ...r, fecha: "2026-10-23" }); assert.equal((await scan()).status, 200);
});

test("QR solo en reservas elegibles; el cliente ve su check-in y el QR desaparece", async () => {
  const r = store.get("reservas").get("res1");
  seed("reservas", "pasada", { ...r, fecha: "2000-01-01" });
  seed("reservas", "cancelada", { ...r, estado: "cancelada" });
  seed("reservas", "futura", { ...r, fecha: "2099-01-01" });
  const antes = (await lista()).body.data;
  assert.ok(antes.find(r => r.id === "res1").qr); assert.ok(antes.find(r => r.id === "futura").qr);
  assert.equal(antes.find(r => r.id === "pasada").qr, null); assert.equal(antes.find(r => r.id === "cancelada").qr, null);
  await scan(); const despues = (await lista()).body.data.find(r => r.id === "res1");
  assert.equal(despues.qr, null); assert.ok(despues.presentadaEn);
});

test("secreto ausente/corto: check-in 503, listado 200 sin ocultar reservas; fallback G08", async () => {
  for (const secreto of [undefined, "corto"]) {
    env.RESERVAS_QR_SECRET = secreto; env.VISITAS_SECRET = undefined;
    const res = await scan("r1.res1.firma"); assert.equal(res.status, 503); assert.equal(res.body.error, "RESERVAS_QR_NO_CONFIGURADO");
    const list = await lista(); assert.equal(list.status, 200); assert.equal(list.body.data.length, 1); assert.equal(list.body.data[0].qr, null);
  }
  env.RESERVAS_QR_SECRET = undefined; env.VISITAS_SECRET = SECRET;
  assert.equal((await scan()).status, 200);
});

test("perfil ausente no deja una llegada parcial ni puntos", async () => {
  store.get("usuarios").delete("u-cli"); assert.equal((await scan()).status, 404);
  assert.equal(store.get("reservas").get("res1").presentadaEn, null);
  assert.equal(store.get("puntos_movimientos")?.size || 0, 0);
});

test("flujo completo: reservar con carta, obtener QR, escanear y consultar pedido fijo presentado", async () => {
  seed("cartas", "r1", { categorias: [{ id: "c", nombre: "Carta", platos: [{ id: "p", nombre: "Plato", precio: 2.5, disponible: true }] }] });
  const nueva = await request(app).post("/v1/reservations").set(auth(tokens.cliente)).send({
    restauranteId: "r1", fecha: hoyMadrid(), hora: "13:00", comensales: 2, pedido: { lineas: [{ platoId: "p", cantidad: 2 }] },
  });
  assert.equal(nueva.status, 201); assert.equal(nueva.body.pedido.total, 5);
  const antes = (await lista()).body.data.find(r => r.id === nueva.body.id);
  assert.equal(leerQrReserva(antes.qr), nueva.body.id);
  seed("cartas", "r1", { categorias: [] });
  const llegada = await scan(antes.qr); assert.equal(llegada.status, 200); assert.equal(llegada.body.puntosPedido, 50);
  assert.deepEqual(llegada.body.reserva.pedido, nueva.body.pedido);
  const despues = (await lista()).body.data.find(r => r.id === nueva.body.id);
  assert.ok(despues.presentadaEn); assert.equal(despues.qr, null); assert.equal(despues.estado, "pendiente");
  assert.equal((await scan(antes.qr)).status, 409);
});
