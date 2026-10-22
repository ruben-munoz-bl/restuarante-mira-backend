const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, mockDb } = require("./helpers/mockFirebase");
const request = require("supertest");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const { hoyMadrid } = require("../src/modules/ofertas/logica");
const { vaciarRanking } = require("../src/modules/restaurants/masReservados");
const app = require("../src/app");
const get = (q = "") => request(app).get(`/v1/restaurants/mas-reservados${q}`);
const dia = n => { const d = new Date(`${hoyMadrid()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const reserva = (id, restaurantId, offset, estado = "pendiente") => seed("reservas", id, { restaurantId, fecha: dia(offset), estado, uid: "privado", email: "privado@test.local", pedido: { total: 123 } });
test.beforeEach(() => { seedBase(); clearRateLimits(); vaciarRanking(); });
test.afterEach(() => { test.mock.restoreAll(); });

test("público: siete días incluyendo hoy, sin canceladas ni datos personales; alias y desempate", async () => {
  reserva("a", "r1", 0); reserva("b", "r1", -6); reserva("c", "r1", -7); reserva("d", "r1", 1); reserva("e", "r1", -1, "cancelada");
  reserva("f", "r2", 0, "no_show");
  seed("reservas", "g", { restauranteId: "r2", fecha: dia(-3), estado: "completada", uid: "privado" });
  seed("reservas", "h", { fecha: dia(0), estado: "pendiente" });
  const res = await get(); assert.equal(res.status, 200);
  assert.deepEqual(res.body, { data: [{ id: "r1", reservas: 2 }, { id: "r2", reservas: 2 }] });
});

test("dias/limit, días de Madrid y máximo30; catálogo sin reservas devuelve vacío", async () => {
  assert.deepEqual((await get()).body, { data: [] }); vaciarRanking();
  reserva("hoy", "r1", 0); reserva("ayer", "r2", -1); reserva("limite", "r2", -29); reserva("fuera", "r2", -30);
  assert.deepEqual((await get("?dias=1")).body.data, [{ id: "r1", reservas: 1 }]);
  assert.deepEqual((await get("?dias=30&limit=1")).body.data, [{ id: "r2", reservas: 2 }]);
  for (const q of ["?dias=0", "?dias=31", "?dias=1.5", "?dias=1x", "?dias=", "?limit=0", "?limit=21", "?limit=-1", "?limit=2.5", "?dias=2&dias=3"]) {
    const r = await get(q); assert.equal(r.status, 400, q); assert.equal(r.body.error, "VALIDATION_ERROR");
  }
});

test("la consulta exige límites de fecha y proyecta solo campos agregables; caché evita repetir lecturas", async () => {
  const original = mockDb.collection.bind(mockDb); let lecturas = 0;
  test.mock.method(mockDb, "collection", name => {
    assert.equal(name, "reservas", "el ranking no lee clientes ni catálogo");
    const condiciones = []; let campos;
    const wrap = q => ({
      where(f, op, v) { condiciones.push([f, op, v]); return wrap(q.where(f, op, v)); },
      select(...args) { campos = args; return wrap(q.select(...args)); },
      async get() {
        lecturas++; assert.deepEqual(condiciones, [["fecha", ">=", dia(-6)], ["fecha", "<=", dia(0)]]);
        assert.deepEqual(campos, ["restaurantId", "restauranteId", "estado"]); return q.get();
      },
    }); return wrap(original(name));
  });
  assert.equal((await get()).status, 200); assert.equal((await get("?limit=1")).status, 200); assert.equal(lecturas, 1);
});

test("cambia de día en Madrid y renueva caché al caducar o al cruzar medianoche", async () => {
  const RealDate = Date; let ms = Date.parse("2026-10-22T21:59:40Z");
  test.mock.method(global, "Date", class extends RealDate { constructor(...a) { super(...(a.length ? a : [ms])); } static now() { return ms; } });
  test.mock.method(Date, "now", () => ms);
  reserva("r", "r1", 0); assert.deepEqual((await get("?dias=1")).body.data, [{ id: "r1", reservas: 1 }]);
  ms += 25_000; assert.deepEqual((await get("?dias=1")).body.data, [], "nuevo día de Madrid aunque solo pasen25s");
  reserva("r2", "r2", 0); ms += 31_000; assert.deepEqual((await get("?dias=1")).body.data, [{ id: "r2", reservas: 1 }]);
});
