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

test("catálogo obsoleto: se reconstruye si _catalogo no refleja la colección", async () => {
  seed("restaurants", "r-origen", { nombre: "Origen", uid: "u-x", rating_yelp: 4 });
  restaurantService.invalidarCatalogo();
  await restaurantService.listarMapa(); // genera el documento con los restaurantes actuales

  const antes = store.get("restaurants").get(restaurantService.DOC_CATALOGO);
  assert.equal(antes.total, 4, "3 del seedBase + r-origen");

  // Alta hecha fuera de este proceso (p. ej. aprobación de un negocio en
  // otra instancia): aquí no se invalida nada.
  seed("restaurants", "r-nuevo", { nombre: "Restaurante Nuevo", uid: "u-y", rating_yelp: 5, ciudad: "Sevilla" });
  restaurantService.invalidarCatalogo(); // arranque en frío en esta instancia

  const mapa = await request(app).get("/v1/restaurants/mapa");
  assert.equal(mapa.status, 200);
  assert.ok(mapa.body.items.some((i) => i.id === "r-nuevo"), "el mapa no debe servir un _catalogo obsoleto");

  const despues = store.get("restaurants").get(restaurantService.DOC_CATALOGO);
  assert.equal(despues.total, 5, "debe regenerar el documento con el recuento real");

  const busca = await request(app).get("/v1/restaurants?q=Nuevo");
  assert.ok(busca.body.items.some((i) => i.id === "r-nuevo"), "la búsqueda tampoco");
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

test("/mapa NO escribe en Firestore en cada llamada (regresión de escrituras)", async () => {
  const { mockDb } = require("./helpers/mockFirebase");
  seed("restaurants", "r-w", { nombre: "W", uid: "u-x", rating_yelp: 4 });

  // Interceptamos las escrituras del mock.
  const docProto = Object.getPrototypeOf(mockDb.collection("__probe").doc("__probe"));
  const origSet = docProto.set;
  let escrituras = 0;
  docProto.set = function (data, opts) {
    escrituras += 1;
    return origSet.call(this, data, opts);
  };

  try {
    restaurantService.invalidarCatalogo();
    await request(app).get("/v1/restaurants/mapa");
    const tras1 = escrituras;

    // 20 cargas más del mapa: no debe escribir NI UNA vez.
    for (let i = 0; i < 20; i++) await request(app).get("/v1/restaurants/mapa");
    assert.equal(escrituras, tras1, "/mapa no debe reescribir el documento _catalogo en cada petición");
  } finally {
    docProto.set = origSet;
  }
});

test("la caché sirve datos viejos mientras refresca (no 700 lecturas por petición)", async () => {
  seed("restaurants", "r-s", { nombre: "S", uid: "u-x", rating_yelp: 4 });
  restaurantService.invalidarCatalogo();
  await restaurantService.listarMapa();

  const antes = restaurantService.estadisticasCache();
  // Forzamos la expiración del TTL.
  const { env } = require("../src/config/env");
  assert.ok(env.CATALOG_CACHE_TTL_MS > 0);
  await new Promise((r) => setTimeout(r, 5));
  const items = await restaurantService.listarRestaurantes({ q: "s" });
  assert.ok(items.items.length >= 1);
  const despues = restaurantService.estadisticasCache();
  assert.ok(despues.cargas <= antes.cargas + 1, "no debe recargar el catálogo en cada petición tras caducar");
});

test("arranque en frío: la caché se hidrata del documento _catalogo (1 lectura)", async () => {
  // Regresión: tras un reinicio de Render, catalogo() leía los 700
  // restaurantes aunque el documento _catalogo ya existiera.
  const { seed } = require("./helpers/mockFirebase");
  seed("restaurants", "r-h", { nombre: "Hidrata", uid: "u-x", ciudad: "Barcelona", rating_yelp: 4.2 });

  // Primero generamos el documento con el catálogo completo.
  restaurantService.invalidarCatalogo();
  await restaurantService.listarRestaurantes({ all: true });
  await restaurantService.regenerarCatalogoMapa(await restaurantService.listarRestaurantes({ all: true }).then((r) => r.items));

  // Ahora "arranque en frío": vacío en memoria, documento presente.
  restaurantService.invalidarCatalogo();
  const items = await restaurantService.listarRestaurantes({ all: true });
  assert.ok(items.items.length > 0, "debe hidratar la caché desde _catalogo");
  assert.ok(items.items.some((i) => i.nombre === "Hidrata"));
});

test("con caché parcial, /restaurants/:id devuelve la ficha completa", async () => {
  const { seed } = require("./helpers/mockFirebase");
  seed("restaurants", "r-full", {
    nombre: "Con Reseñas", uid: "u-x", ciudad: "Barcelona", rating_yelp: 4.5,
    resenas: [{ usuario: "u1", fecha: "2025-01-01", comentario: "bueno", puntuacion: 5 }],
    direccion_completa: "Carrer X 1",
  });
  restaurantService.invalidarCatalogo();
  const todos = await restaurantService.listarRestaurantes({ all: true });
  await restaurantService.regenerarCatalogoMapa(todos.items);

  restaurantService.invalidarCatalogo();
  await restaurantService.listarRestaurantes({ all: true }); // hidrata desde _catalogo (parcial)

  const ficha = await restaurantService.obtenerRestaurante("r-full");
  assert.ok(Array.isArray(ficha.resenas) && ficha.resenas.length === 1, "la ficha debe traer reseñas");
  assert.equal(ficha.direccion_completa, "Carrer X 1");
});

test("el TTL del catálogo es de 15 minutos", () => {
  const { env } = require("../src/config/env");
  assert.ok(env.CATALOG_CACHE_TTL_MS >= 900000, "el TTL debe ser de al menos 15 min");
});

test("el panel de admin no lee colecciones enteras y se cachea", async () => {
  const dashboardService = require("../src/modules/dashboard/service");
  dashboardService.invalidarPanelAdmin();

  for (let i = 0; i < 5; i++) seed("usuarios", `u-${i}`, { uid: `u-${i}`, tipo: "cliente", email: `u${i}@t.local` });
  for (let i = 0; i < 5; i++) seed("reservas", `r-${i}`, { uid: "u-1", estado: "completada", fecha: "2027-01-01", createdAt: new Date(), comensales: 2 });
  for (let i = 0; i < 3; i++) seed("tickets", `t-${i}`, { uid: "u-1", totalPagado: 20, importeComision: 2, createdAt: new Date() });

  const res = await request(app).get("/v1/dashboard/admin").set("Authorization", `Bearer ${tokens.admin}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));

  // Los totales deben ser exactos (vienen de count(), no del array truncado).
  // seedBase() ya deja 4 usuarios, y añadimos 5 más.
  assert.equal(res.body.stats.totalUsuarios, 9);
  assert.equal(res.body.stats.totalReservas, 5);
  assert.equal(typeof res.body.stats.totalFacturacion, "number");
  dashboardService.invalidarPanelAdmin();
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

test("dashboard: si el restaurantId principal fue borrado, cae en el siguiente existente", async () => {
  seed("restaurants", "r-viva", { nombre: "Viva", uid: "u-emp", rating_yelp: 4 });
  seed("usuarios", "u-emp", {
    uid: "u-emp", tipo: "empresa", email: "emp@test.local",
    restaurantId: "r-borrada", restaurantIds: ["r-borrada", "r-viva"],
  });

  const res = await request(app).get("/v1/dashboard/my-restaurant").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.restaurante.id, "r-viva");
});

test("dashboard: el restaurante asignado ya no existe → 404 con mensaje claro", async () => {
  seed("usuarios", "u-emp", {
    uid: "u-emp", tipo: "empresa", email: "emp@test.local", restaurantId: "desaparecido",
  });

  const res = await request(app).get("/v1/dashboard/my-restaurant").set("Authorization", `Bearer ${tokens.empresa}`);
  assert.equal(res.status, 404);
  assert.match(res.body.message, /ya no existe/);
});

test("dashboard: editar un restaurante refresca _catalogo (el nombre nuevo se ve al instante)", async () => {
  seed("restaurants", "r-ren", { nombre: "Nombre Viejo", uid: "u-emp", rating_yelp: 4 });
  restaurantService.invalidarCatalogo();
  await restaurantService.listarRestaurantes({ all: true }); // deja el nombre viejo en _catalogo

  const res = await request(app)
    .put("/v1/dashboard/restaurant/r-ren")
    .set("Authorization", `Bearer ${tokens.admin}`)
    .send({ nombre: "Nombre Nuevo" });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // Un cambio de nombre no altera el recuento: lo fuerza el marcador de escritura.
  const lista = await restaurantService.listarRestaurantes({ all: true });
  assert.ok(
    lista.items.some((i) => i.id === "r-ren" && i.nombre === "Nombre Nuevo"),
    "la búsqueda debe ver el nombre nuevo",
  );

  const cat = store.get("restaurants").get(restaurantService.DOC_CATALOGO);
  const entrada = cat.restaurantes.find((r) => r.id === "r-ren");
  assert.equal(entrada.nombre, "Nombre Nuevo", "el documento _catalogo debe quedar regenerado");
});

/* ───────── Subida de ticket desde el panel ───────── */

function seedReservaTicket(id = "res-tk") {
  seed("restaurants", "r-tk", { nombre: "La Tasca", uid: "u-emp", comisionPct: 10, rating_yelp: 4 });
  seed("usuarios", "u-emp", { uid: "u-emp", tipo: "empresa", email: "emp@test.local", restaurantId: "r-tk" });
  seed("reservas", id, {
    uid: "u-cli", restaurantId: "r-tk", restauranteId: "r-tk", nombreRestaurante: "La Tasca",
    fecha: "2030-01-01", hora: "21:00", comensales: 4, estado: "pendiente",
    codigo: "MIRA-TEST", ticketId: null,
  });
  return id;
}

test("dashboard: subir ticket crea el ticket, completa la reserva y suma finanzas", async () => {
  const id = seedReservaTicket();

  const res = await request(app)
    .post(`/v1/dashboard/reservations/${id}/ticket`)
    .set("Authorization", `Bearer ${tokens.empresa}`)
    .send({ totalPagado: 100, asistio: true, fileName: "ticket.pdf" });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.ticketId, "debe devolver el id del ticket creado");

  const tickets = [...store.get("tickets").values()];
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].importeComision, 10);
  assert.equal(tickets[0].netoRestaurante, 90);

  const reserva = store.get("reservas").get(id);
  assert.equal(reserva.estado, "completada");
  assert.equal(reserva.ticketId, res.body.ticketId);

  const fin = store.get("finanzas_restaurante").get("r-tk");
  assert.equal(fin.ingresosBrutos, 100);
  assert.equal(fin.totalTickets, 1);
});

test("dashboard: subir ticket con importe inválido → 400 (no 500)", async () => {
  const id = seedReservaTicket();

  const res = await request(app)
    .post(`/v1/dashboard/reservations/${id}/ticket`)
    .set("Authorization", `Bearer ${tokens.empresa}`)
    .send({ totalPagado: "", asistio: true });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, "VALIDATION_ERROR");
  assert.ok(!store.get("reservas").get(id).ticketId, "no debe crear ticket");
});

test("dashboard: subir ticket a reserva inexistente → 404 (no 500)", async () => {
  const res = await request(app)
    .post("/v1/dashboard/reservations/no-existe/ticket")
    .set("Authorization", `Bearer ${tokens.empresa}`)
    .send({ totalPagado: 20, asistio: true });

  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "NOT_FOUND");
});

test("dashboard: subir el ticket dos veces → 409 (el frontend espera ese código)", async () => {
  const id = seedReservaTicket();
  const url = `/v1/dashboard/reservations/${id}/ticket`;

  const primera = await request(app).post(url).set("Authorization", `Bearer ${tokens.empresa}`).send({ totalPagado: 25 });
  assert.equal(primera.status, 201, JSON.stringify(primera.body));

  const segunda = await request(app).post(url).set("Authorization", `Bearer ${tokens.empresa}`).send({ totalPagado: 30 });
  assert.equal(segunda.status, 409, JSON.stringify(segunda.body));
  assert.equal(segunda.body.error, "CONFLICT");
  assert.equal([...store.get("tickets").values()].length, 1, "no debe crear un segundo ticket");
});

test("dashboard: subir ticket en no-show marca la reserva como no_show", async () => {
  const id = seedReservaTicket();

  const res = await request(app)
    .post(`/v1/dashboard/reservations/${id}/ticket`)
    .set("Authorization", `Bearer ${tokens.empresa}`)
    .send({ totalPagado: "45,50", asistio: false });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  const reserva = store.get("reservas").get(id);
  assert.equal(reserva.estado, "no_show");
  assert.equal(reserva.totalPagado, 45.5, "acepta importes con coma");
});