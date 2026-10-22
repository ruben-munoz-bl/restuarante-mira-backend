const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const request = require("supertest");
const svc = require("../src/modules/restaurants/service");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const app = require("../src/app");
const auth = t => ({ Authorization: `Bearer ${t}` });
const fecha = "2026-10-22T10:30:00.000Z";
test.beforeEach(() => { seedBase(); clearRateLimits(); svc.invalidarCatalogoPorEscritura(); });

test("catálogo y mapa exponen creado ISO desde Timestamp, Date, ISO y null para Yelp/fechas inválidas", async () => {
  const valores = [new Date(fecha), { seconds: Date.parse(fecha) / 1000, nanoseconds: 0 },
    { toDate: () => new Date(fecha) }, fecha, null, undefined, "invalida", { seconds: NaN }];
  valores.forEach((creado, i) => seed("restaurants", `alta${i}`, { nombre: `Local ${i}`, creado, rating_yelp: 4 }));
  for (const ruta of ["/v1/restaurants?all=1", "/v1/restaurants/mapa"]) {
    const res = await request(app).get(ruta); assert.equal(res.status, 200);
    for (let i = 0; i < valores.length; i++) assert.equal(res.body.items.find(r => r.id === `alta${i}`).creado, i < 4 ? fecha : null);
    for (const id of ["r1", "r2", "r3"]) assert.equal(res.body.items.find(r => r.id === id).creado, null);
  }
  assert.equal(store.get("restaurants").get("r1").creado, undefined, "sin backfill ni escrituras en documentos Yelp");
});

test("fecha se conserva al hidratar desde _catalogo y fuerza reconstruir caché del formato anterior", async () => {
  seed("restaurants", "nuevo", { nombre: "Nuevo", creado: fecha });
  await request(app).get("/v1/restaurants?all=1");
  const doc = store.get("restaurants").get("_catalogo");
  assert.equal(doc.restaurantes.find(r => r.id === "nuevo").creado, fecha);
  svc.vaciarMemoriaCatalogo();
  assert.equal((await request(app).get("/v1/restaurants?all=1")).body.items.find(r => r.id === "nuevo").creado, fecha);
  seed("restaurants", "_catalogo", { ...doc, version: doc.version.filter(c => c !== "creado"), restaurantes: doc.restaurantes.map(({ creado, ...r }) => r) });
  svc.vaciarMemoriaCatalogo();
  assert.equal((await request(app).get("/v1/restaurants?all=1")).body.items.find(r => r.id === "nuevo").creado, fecha);
});

test("alta desde propuesta del admin y aprobación guarda creado real y lo expone en catálogo", async () => {
  const propuesta = await request(app).post("/v1/negocios").set(auth(tokens.admin)).send({
    nombre: "Alta admin", ciudad: "Madrid", zona: "Centro", direccion: "Calle 1", categorias: ["Española"], precio: "€€",
    creado: "1900-01-01T00:00:00.000Z",
  });
  assert.equal(propuesta.status, 201);
  const antes = Date.now();
  const aprobada = await request(app).put(`/v1/negocios/${propuesta.body.id}/aprobar`).set(auth(tokens.admin));
  assert.equal(aprobada.status, 200);
  const guardado = store.get("restaurants").get(aprobada.body.restaurantId).creado;
  assert.ok(Date.parse(guardado) >= antes); assert.ok(Date.parse(guardado) <= Date.now());
  const catalogo = await request(app).get("/v1/restaurants?all=1");
  assert.equal(catalogo.body.items.find(r => r.id === aprobada.body.restaurantId).creado, guardado);
});
