const test = require("node:test");
const assert = require("node:assert");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");

const request = require("supertest");
const app = require("../src/app");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const restaurantService = require("../src/modules/restaurants/service");

test.beforeEach(() => {
  seedBase();
  clearRateLimits();
  restaurantService.invalidarCatalogo();
});

/* ───────── Endpoint del mapa ───────── */

test("GET /v1/restaurants/mapa devuelve campos ligeros y mucho más pequeño que all=1", async () => {
  for (let i = 0; i < 30; i++) {
    seed("restaurants", `r-${i}`, {
      nombre: `Restaurante ${i}`, uid: "u-x", ciudad: i % 2 ? "Barcelona" : "Tarragona",
      rating_yelp: 4 + (i % 10) / 10, precio: "€€", categorias: ["Italian", "Pizza"],
      coordenadas: { latitud: 41 + i / 100, longitud: 2 + i / 100 },
      imagen_url: `https://img/${i}.jpg`,
      descripcion: "x".repeat(400),
      resenas: Array.from({ length: 5 }, (_, j) => ({ usuario: `u${j}`, fecha: "2025-01-01", comentario: "y".repeat(120), puntuacion: 5 })),
    });
  }

  const mapa = await request(app).get("/v1/restaurants/mapa");
  const all = await request(app).get("/v1/restaurants?all=1");

  assert.equal(mapa.status, 200);
  assert.ok(mapa.body.items.length > 0);

  // Solo los 8 campos del mapa, sin reseñas ni descripciones.
  const item = mapa.body.items[0];
  for (const campo of ["id", "nombre", "coordenadas", "rating_yelp", "precio", "categorias", "imagen_url", "ciudad"]) {
    assert.ok(campo in item, `debe incluir ${campo}`);
  }
  assert.equal(item.resenas, undefined, "no debe incluir reseñas");
  assert.equal(item.descripcion, undefined, "no debe incluir descripción");

  // El peso debe ser mucho menor.
  const pesoMapa = JSON.stringify(mapa.body).length;
  const pesoAll = JSON.stringify(all.body).length;
  assert.ok(pesoMapa < pesoAll / 2, `el mapa (${pesoMapa}) debe ser mucho menor que all=1 (${pesoAll})`);
});

test("GET /v1/restaurants/mapa filtra por ciudad", async () => {
  seed("restaurants", "r-bcn", { nombre: "B", uid: "u-x", ciudad: "Barcelona", rating_yelp: 4 });
  seed("restaurants", "r-tar", { nombre: "T", uid: "u-x", ciudad: "Tarragona", rating_yelp: 4 });

  const res = await request(app).get("/v1/restaurants/mapa?ciudad=Tarragona");
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((i) => i.ciudad === "Tarragona"));
  assert.ok(res.body.items.length >= 1);
});

test("el documento __catalogo__ nunca aparece como restaurante", async () => {
  seed("restaurants", "r-real", { nombre: "Real", uid: "u-x", rating_yelp: 4 });
  await request(app).get("/v1/restaurants/mapa");

  const lista = await request(app).get("/v1/restaurants");
  assert.ok(!lista.body.items.some((i) => i.id === restaurantService.DOC_CATALOGO));

  const count = await request(app).get("/v1/restaurants/count");
  const total = await restaurantService.listarRestaurantes({ all: true });
  assert.equal(count.body.total, total.items.length, "el contador no debe incluir el documento técnico");
});

test("el catálogo ligero se lee desde 1 documento tras un arranque en frío", async () => {
  for (let i = 0; i < 20; i++) seed("restaurants", `rc-${i}`, { nombre: `C${i}`, uid: "u-x", rating_yelp: 4 });

  await request(app).get("/v1/restaurants/mapa");       // genera el documento
  restaurantService.invalidarCatalogo();                 // simula reinicio en frío

  const statsAntes = restaurantService.estadisticasCache();
  const res = await request(app).get("/v1/restaurants/mapa");
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 20, "debe devolver el catálogo completo desde el documento");

  const statsDespues = restaurantService.estadisticasCache();
  assert.equal(statsDespues.cargas, statsAntes.cargas, "no debe releer los restaurantes sueltos");
});

/* ───────── POST /v1/points/discount/claim ───────── */

test("POST /v1/points/discount/claim sin token → 401", async () => {
  const res = await request(app).post("/v1/points/discount/claim").send({ descuentoId: "5" });
  assert.equal(res.status, 401);
});

test("POST /v1/points/discount/claim canjea puntos y genera cupón", async () => {
  seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", saldoPuntos: 2000, totalCanjeado: 0 });

  const res = await request(app)
    .post("/v1/points/discount/claim")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ descuentoId: "10" });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.nuevoSaldo, 1000);
  assert.ok(res.body.cupon.codigo.startsWith("MIRA-"));
  assert.equal(res.body.cupon.estado, "activo");

  // El saldo en Firestore debe estar descontado y existir el movimiento.
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 1000);
  const movs = [...store.get("puntos_movimientos").values()];
  assert.ok(movs.some((m) => m.tipo === "canje_descuento" && m.puntos === -1000));
});

test("POST /v1/points/discount/claim con saldo insuficiente → 400 INSUFFICIENT", async () => {
  seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", saldoPuntos: 10, totalCanjeado: 0 });

  const res = await request(app)
    .post("/v1/points/discount/claim")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ descuentoId: "20" });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INSUFFICIENT");
  assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 10, "el saldo no debe cambiar");
});

test("POST /v1/points/discount/claim con descuento inexistente → 400", async () => {
  seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", saldoPuntos: 2000 });
  const res = await request(app)
    .post("/v1/points/discount/claim")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({ descuentoId: "999" });
  assert.equal(res.status, 400);
});

test("POST /v1/points/discount/claim sin body → 400 VALIDATION_ERROR", async () => {
  const res = await request(app)
    .post("/v1/points/discount/claim")
    .set("Authorization", `Bearer ${tokens.cliente}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("GET /v1/points/discounts lista el catálogo", async () => {
  const res = await request(app).get("/v1/points/discounts").set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.descuentos.length >= 3);
  assert.ok(res.body.descuentos.every((d) => d.puntos > 0 && d.euros > 0));
});

/* ───────── Dashboard del restaurante ───────── */

test("POST /v1/points/redeem acepta puntos, descuentoId y string numérico", async () => {
  // Regresión: el frontend mandaba {descuentoId} a /redeem y recibía
  // VALIDATION_ERROR ("puntos Required"). Ahora ambas formas valen.
  const conSaldo = (saldo) => seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", saldoPuntos: saldo, totalCanjeado: 0 });

  // 1) Formato clásico: puntos como número
  conSaldo(5000);
  let res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ puntos: 500 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.nuevoSaldo, 4500);
  assert.equal(res.body.canjeadoComo, "puntos");

  // 2) Formato descuento (id como string) → genera cupón
  conSaldo(5000);
  res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ descuentoId: "5" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.nuevoSaldo, 4500);
  assert.ok(res.body.cupon.codigo.startsWith("MIRA-"));
  assert.equal(res.body.canjeadoComo, "descuento");

  // 3) Puntos como texto ("500") → típico de un input de formulario
  conSaldo(5000);
  res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ puntos: "500" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.nuevoSaldo, 4500);

  // 4) Importe con símbolo y número sueltos
  conSaldo(5000);
  res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ descuentoId: "5 €" });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  conSaldo(5000);
  res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ descuentoId: 10 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("POST /v1/points/redeem sin puntos ni descuento → error claro", async () => {
  const res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "VALIDATION_ERROR");
});

test("POST /v1/points/redeem con descuento inexistente → 400 con mensaje", async () => {
  seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", saldoPuntos: 5000 });
  const res = await request(app).post("/v1/points/redeem").set("Authorization", `Bearer ${tokens.cliente}`).send({ descuentoId: "999" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /descuento no existe/i);
});

test("dashboard: my-restaurant devuelve el restaurante completo cuando SÍ tiene", async () => {
  seed("restaurants", "r-mio", {
    nombre: "Mi Restaurante", uid: "u-emp", email: "emp@test.local", ciudad: "Barcelona",
    rating_yelp: 4.5, categorias: ["Italian"], coordenadas: { latitud: 41.3, longitud: 2.1 },
  });
  seed("usuarios", "u-emp", {
    uid: "u-emp", tipo: "empresa", email: "emp@test.local",
    restaurantId: "r-mio", restaurantIds: ["r-mio"], saldoPuntos: 50,
  });

  const res = await request(app).get("/v1/dashboard/my-restaurant").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.restaurante.id, "r-mio");
  assert.equal(res.body.restaurante.nombre, "Mi Restaurante");
  // Todas las claves que el frontend espera, aunque estén vacías.
  for (const k of ["restaurante", "finanzas", "stats", "proximasReservas", "reservasHoy", "reservasParaTicket", "ingresosPorMes", "ticketsRecientes"]) {
    assert.ok(k in res.body, `falta la clave ${k}`);
  }
  assert.equal(typeof res.body.stats.totalReservas, "number");
});

test("dashboard: my-restaurants lista los restaurantes del usuario", async () => {
  seed("restaurants", "r-a", { nombre: "A", uid: "u-emp", ciudad: "Barcelona" });
  seed("restaurants", "r-b", { nombre: "B", uid: "u-emp", ciudad: "Tarragona" });

  const res = await request(app).get("/v1/dashboard/my-restaurants").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
});

test("dashboard: usa restaurantId principal y no uno arbitrario", async () => {
  seed("restaurants", "r-1", { nombre: "Uno", uid: "u-emp" });
  seed("restaurants", "r-2", { nombre: "Dos", uid: "u-emp" });
  // Solo restaurantIds, sin restaurantId: debe elegir el primero de la lista.
  seed("usuarios", "u-emp", { uid: "u-emp", tipo: "empresa", restaurantIds: ["r-2", "r-1"] });

  const res = await request(app).get("/v1/dashboard/my-restaurant").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.restaurante.id, "r-2", "debe respetar el orden de restaurantIds");
});

test("dashboard: no deja ver el panel de otro restaurante (403)", async () => {
  seed("restaurants", "r-ajeno", { nombre: "Ajeno", uid: "u-otro" });
  seed("restaurants", "r-mio", { nombre: "Mio", uid: "u-emp" });
  seed("usuarios", "u-emp", { uid: "u-emp", tipo: "empresa", restaurantId: "r-mio" });

  const res = await request(app)
    .get("/v1/dashboard/my-restaurant?restaurantId=r-ajeno")
    .set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "FORBIDDEN");
});

test("dashboard: el admin sí puede ver cualquier restaurante", async () => {
  seed("restaurants", "r-ajeno", { nombre: "Ajeno", uid: "u-otro" });
  seed("usuarios", "u-admin", { uid: "u-admin", tipo: "admin" });

  const res = await request(app)
    .get("/v1/dashboard/my-restaurant?restaurantId=r-ajeno")
    .set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.restaurante.id, "r-ajeno");
});

test("dashboard: sin restaurante propio → 404 con mensaje claro", async () => {
  const res = await request(app).get("/v1/dashboard/my-restaurant").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 404);
  assert.match(res.body.message, /no tiene ningún restaurante asignado/);
});

test("dashboard: my-restaurants sin restaurantes → 200 lista vacía (no 404)", async () => {
  const res = await request(app).get("/v1/dashboard/my-restaurants").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});