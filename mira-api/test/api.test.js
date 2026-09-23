/**
 * Tests de funcionamiento: restaurants (paginación, búsqueda), reservas, puntos.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { seedBase, seed, tokens } = require("./helpers/mockFirebase");
require("./helpers/mockFirebase");

let app;
let clearRateLimits;

before(async () => {
  app = require("../src/app");
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

beforeEach(() => {
  seedBase();
  if (clearRateLimits) clearRateLimits();
});

/* ───────── Restaurants: paginación progresiva ───────── */

test("REST sin limit → tanda por defecto 27 (o todo si hay menos)", async () => {
  const res = await request(app).get("/v1/restaurants");
  assert.equal(res.status, 200);
  // seedBase tiene 3 docs: terminado con los 3; el tamaño de página es 27
  assert.ok(res.body.items.length <= 27);
  assert.equal(res.body.terminado, true);
});

test("REST primera página limit=2 → 2 items + cursor + terminado=false", async () => {
  const res = await request(app).get("/v1/restaurants?limit=2");
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.cursor, "debe devolver cursor para scroll infinito");
  assert.equal(res.body.terminado, false);
  // rating desc: r2(4.8), r1(4.5)
  assert.equal(res.body.items[0].id, "r2");
  assert.equal(res.body.items[1].id, "r1");
});

test("REST segunda página con cursor → página siguiente sin repetir", async () => {
  const p1 = await request(app).get("/v1/restaurants?limit=2");
  const cursor = p1.body.cursor;
  assert.ok(cursor);
  const p2 = await request(app).get(`/v1/restaurants?limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(p2.status, 200);
  assert.equal(p2.body.items.length, 1);
  assert.equal(p2.body.terminado, true);
  assert.equal(p2.body.items[0].id, "r3");
  // sin solapes
  const ids1 = new Set(p1.body.items.map((x) => x.id));
  for (const it of p2.body.items) assert.ok(!ids1.has(it.id), "no debe repetir ids entre páginas");
});

test("REST all=1 → catálogo completo terminado", async () => {
  const res = await request(app).get("/v1/restaurants?all=1");
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 3);
  assert.equal(res.body.terminado, true);
  assert.equal(res.body.cursor, null);
});

test("REST filtro cocina → solo esa categoría", async () => {
  const res = await request(app).get("/v1/restaurants?all=1&cocina=Japonesa");
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, "r2");
});

test("REST búsqueda q=roma (insensible a acentos/case)", async () => {
  const res = await request(app).get("/v1/restaurants?all=1&q=ROMA");
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, "r3");
});

test("REST búsqueda q con acento → encuentra", async () => {
  const res = await request(app).get("/v1/restaurants?all=1&q=Tarragona");
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
});

test("REST búsqueda q sin all=1 → pagina resultados filtrados (no solo la página cruda)", async () => {
  const res = await request(app).get("/v1/restaurants?limit=2&q=roma");
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, "r3");
  assert.equal(res.body.terminado, true);
});

/* ───────── Dashboard admin: gestión restaurantes ───────── */

test("DASH GET /v1/dashboard/restaurants admin → página + cursor", async () => {
  const res = await request(app)
    .get("/v1/dashboard/restaurants?limit=2")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.cursor);
  assert.equal(res.body.terminado, false);
});

test("DASH GET /v1/dashboard/restaurants cliente → 403", async () => {
  const res = await request(app)
    .get("/v1/dashboard/restaurants")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
});

test("DASH PUT /v1/dashboard/restaurant/:id admin → actualiza campos permitidos", async () => {
  const res = await request(app)
    .put("/v1/dashboard/restaurant/r1")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ telefono: "910000001", comisionPct: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, true);
});

test("DASH POST message admin → 201 y crea mensaje para dueño (uid)", async () => {
  const { seed, store } = require("./helpers/mockFirebase");
  seed("restaurants", "r1", { nombre: "Casa Lucio", uid: "u-emp", email: "emp@test.local" });
  const res = await request(app)
    .post("/v1/dashboard/restaurant/r1/message")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ asunto: "Revisión", mensaje: "Hola dueño" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.uidDueno, "u-emp");
  const msgs = store.get("mensajes");
  assert.ok(msgs && msgs.size >= 1);
  const m = [...msgs.values()].find((x) => x.cuerpo === "Hola dueño");
  assert.ok(m, "debe guardar el cuerpo del mensaje");
  assert.equal(m.uid, "u-emp");
  assert.equal(m.leido, false);
});

test("DASH POST message sin dueño → 400", async () => {
  const { seed } = require("./helpers/mockFirebase");
  seed("restaurants", "r2", { nombre: "Sushi Zen", uid: null, email: null, ownerUid: null });
  const res = await request(app)
    .post("/v1/dashboard/restaurant/r2/message")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ mensaje: "Prueba" });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test("DASH DELETE /v1/dashboard/restaurant/:id admin → elimina", async () => {
  const res = await request(app)
    .delete("/v1/dashboard/restaurant/r3")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, true);
  const get = await request(app).get("/v1/restaurants/r3");
  assert.equal(get.status, 404);
});

test("DASH DELETE restaurante inexistente → 404", async () => {
  const res = await request(app)
    .delete("/v1/dashboard/restaurant/nope")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 404);
});

test("DASH DELETE cliente → 403", async () => {
  const res = await request(app)
    .delete("/v1/dashboard/restaurant/r1")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
});

/* ───────── Reservas ───────── */

test("RES GET /v1/reservations con token → 200 lista", async () => {
  const res = await request(app)
    .get("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
});

test("RES POST /v1/reservations válida → 201 con codigo", async () => {
  const res = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({
      restaurantId: "r1",
      fecha: "2099-12-31",
      hora: "13:00",
      comensales: 2,
      comentarios: "test",
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.id);
  assert.ok(res.body.codigo);
  assert.equal(res.body.fecha, "2099-12-31");
});

test("RES POST hora fuera de SLOTS → 400", async () => {
  const res = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restaurantId: "r1", fecha: "2099-12-31", hora: "09:00", comensales: 2 });
  assert.equal(res.status, 400);
});

test("RES POST comensales fuera de rango → 400", async () => {
  const res = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restaurantId: "r1", fecha: "2099-12-31", hora: "13:00", comensales: 99 });
  assert.equal(res.status, 400);
});

test("RES GET availability público → 200", async () => {
  const res = await request(app).get("/v1/reservations/availability?restauranteId=r1&fecha=2099-12-31&hora=13:00");
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.limite === "number");
});

test("RES GET availability restaurante inexistente → 404", async () => {
  const res = await request(app).get("/v1/reservations/availability?restauranteId=nope&fecha=2099-12-31&hora=13:00");
  assert.equal(res.status, 404);
});

test("RES cancelar reserva ajena → 403", async () => {
  // crear como cliente
  const created = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restaurantId: "r1", fecha: "2099-11-30", hora: "20:00", comensales: 2 });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // cancelar como cliente2 (no dueño, no admin)
  const res = await request(app)
    .put(`/v1/reservations/${id}/cancel`)
    .set("Authorization", `Bearer ${tokens.cliente2}`);
  assert.equal(res.status, 403);
});

test("RES cancelar la propia → 200", async () => {
  const created = await request(app)
    .post("/v1/reservations")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restaurantId: "r1", fecha: "2099-11-29", hora: "12:30", comensales: 2 });
  const id = created.body.id;
  const res = await request(app)
    .put(`/v1/reservations/${id}/cancel`)
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.estado, "cancelada");
});

/* ───────── Puntos ───────── */

test("PTS GET balance con token → 200 shape frontend", async () => {
  const res = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.saldoActual === "number");
  assert.ok(res.body.rachaLogin);
  assert.ok(res.body.rachaReservas);
});

test("PTS GET is-new-user → isNew boolean", async () => {
  const res = await request(app)
    .get("/v1/points/is-new-user")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.isNew, "boolean");
});

test("PTS GET ledger → { data: [] }", async () => {
  const res = await request(app)
    .get("/v1/points/ledger")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
});

test("PTS GET wheel/prizes → 5 premios", async () => {
  const res = await request(app)
    .get("/v1/points/wheel/prizes")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.prizes.length, 5);
});

test("PTS POST daily-login → 201 o 201 con puntos", async () => {
  const res = await request(app)
    .post("/v1/points/daily-login")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.ok([200, 201].includes(res.status), `status=${res.status}`);
  assert.ok(typeof res.body.puntos === "number" || res.body.yaReclamado === true);
});

/* ───────── Admin: racha + puntos (panel usuarios) ───────── */

test("PTS dashboard racha/set → solo admin (cliente 403)", async () => {
  const no = await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ uid: "u-admin", dias: 5 });
  assert.equal(no.status, 403);
  assert.equal(no.body.error, "FORBIDDEN");

  const res = await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-admin", dias: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.rachaLogin.dias, 5);
});

test("PTS dashboard racha/set → deja hoy reclamable (ultimoLogin≠hoy)", async () => {
  await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", dias: 5 });
  const bal = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(bal.body.rachaLogin.dias, 5);
  assert.equal(bal.body.rachaLogin.yaReclamado, false);
});

test("PTS dashboard racha/delta → suma y clamp a 7 (admin)", async () => {
  await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-admin", dias: 6 });
  const res = await request(app)
    .post("/v1/dashboard/points/racha/delta")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-admin", delta: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.rachaLogin.dias, 7);
});

test("PTS dashboard racha/delta negativo → resta y clamp a 0", async () => {
  await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", dias: 2 });
  const res = await request(app)
    .post("/v1/dashboard/points/racha/delta")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", delta: -5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.rachaLogin.dias, 0);
});

test("PTS wheel sin racha 7 → 403 WHEEL_LOCKED", async () => {
  await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-admin", dias: 3 });
  // resetea la del cliente para no arrastrar estado
  await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", dias: 0 });
  const res = await request(app)
    .post("/v1/points/wheel")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "WHEEL_LOCKED");
});

test("PTS unlock-ruleta via racha/set 7 + gira → 201 y racha resetea a 0", async () => {
  const unlock = await request(app)
    .post("/v1/dashboard/points/racha/set")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", dias: 7 });
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.rachaLogin.dias, 7);

  const wheel = await request(app)
    .post("/v1/points/wheel")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(wheel.status, 201);
  assert.ok(wheel.body.puntos >= 20);

  const bal = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(bal.body.rachaLogin.dias, 0);
});

test("PTS unclaim-today → puede volver a reclamar", async () => {
  const claim = await request(app)
    .post("/v1/points/daily-login")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(claim.status, 201);

  const bal1 = await request(app)
    .get("/v1/points/balance")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(bal1.body.rachaLogin.yaReclamado, true);
  const diasTras = bal1.body.rachaLogin.dias;

  const un = await request(app)
    .post("/v1/dashboard/points/racha/unclaim-today")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli" });
  assert.equal(un.status, 200);
  assert.equal(un.body.estabaReclamadoHoy, true);
  assert.equal(un.body.rachaLogin.yaReclamado, false);
  assert.equal(un.body.rachaLogin.dias, Math.max(0, diasTras - 1));

  const claim2 = await request(app)
    .post("/v1/points/daily-login")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(claim2.status, 201);
  assert.ok(claim2.body.puntos > 0);
});

test("PTS unclaim-today cliente → 403", async () => {
  const res = await request(app)
    .post("/v1/dashboard/points/racha/unclaim-today")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ uid: "u-cli" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "FORBIDDEN");
});

test("PTS add-manual → admin suma/resta; cliente 403", async () => {
  const no = await request(app)
    .post("/v1/dashboard/points/add-manual")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ uid: "u-cli", cantidad: 100 });
  assert.equal(no.status, 403);

  const add = await request(app)
    .post("/v1/dashboard/points/add-manual")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", cantidad: 50, motivo: "Bono test" });
  assert.equal(add.status, 200);
  assert.equal(add.body.nuevoSaldo, 50);

  const sub = await request(app)
    .post("/v1/dashboard/points/add-manual")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", cantidad: -20, motivo: "Resta" });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.nuevoSaldo, 30);
});

test("PTS add-manual cantidad no entera → 400", async () => {
  const res = await request(app)
    .post("/v1/dashboard/points/add-manual")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ uid: "u-cli", cantidad: 1.5 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("DASH GET /v1/dashboard/users → incluye rachaLoginDias", async () => {
  const res = await request(app)
    .get("/v1/dashboard/users")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
  const cli = res.body.find((u) => u.uid === "u-cli");
  assert.ok(cli);
  assert.ok(typeof cli.rachaLoginDias === "number");
  assert.ok("yaReclamadoHoy" in cli);
});

/* ───────── Users / perfil ───────── */

test("USR GET /v1/users/me → 200 con uid", async () => {
  const res = await request(app)
    .get("/v1/users/me")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.uid, "u-cli");
});

test("USR GET /v1/users/me/is-admin → isAdmin false para cliente", async () => {
  const res = await request(app)
    .get("/v1/users/me/is-admin")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.isAdmin, false);
});

test("USR GET /v1/users/me/is-admin → isAdmin true para admin", async () => {
  const res = await request(app)
    .get("/v1/users/me/is-admin")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.isAdmin, true);
});

/* ───────── Reseñas ───────── */

test("REV GET /v1/reviews/:id (público) → 200 lista", async () => {
  const res = await request(app).get("/v1/reviews/r1");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
});

test("REV POST /v1/reviews válida → 201", async () => {
  const res = await request(app)
    .post("/v1/reviews")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ restauranteId: "r1", puntuacion: 5, comentario: "¡Excelente!" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.id || res.body.reviewId);
});

/* ───────── Invitaciones ───────── */

test("INV GET /v1/invite/my → shape frontend", async () => {
  const res = await request(app)
    .get("/v1/invite/my")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.enviadas));
  assert.ok(typeof res.body.aceptadas === "number");
});
