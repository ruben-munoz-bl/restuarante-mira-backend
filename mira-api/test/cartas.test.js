const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, tokens } = require("./helpers/mockFirebase");
const request = require("supertest");
const { clearRateLimits } = require("../src/middlewares/rateLimit");
const app = require("../src/app");
const auth = token => ({ Authorization: `Bearer ${token}` });
const plato = (extra = {}) => ({ nombre: "Croquetas", descripcion: "6 unidades", precio: 9.5, alergenos: ["gluten"], disponible: true, ...extra });
const carta = () => ({ categorias: [{ nombre: "Entrantes", platos: [plato()] }] });
const put = (body = carta(), token = tokens.empresa, id = "r1") => request(app).put(`/v1/cartas/${id}`).set(auth(token)).send(body);
test.beforeEach(() => {
  seedBase(); clearRateLimits();
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
});

test("carta pública inexistente 404; editor vacío 200; restaurante inexistente 404", async () => {
  assert.equal((await request(app).get("/v1/cartas/r1")).status, 404);
  const res = await request(app).get("/v1/cartas/r1/editar").set(auth(tokens.empresa));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { restauranteId: "r1", categorias: [], actualizada: null });
  for (const ruta of ["/v1/cartas/ausente", "/v1/cartas/ausente/editar"]) assert.equal((await request(app).get(ruta).set(auth(tokens.admin))).status, 404);
  assert.equal((await put(carta(), tokens.admin, "ausente")).status, 404);
});

test("guardar genera IDs válidos; editar conserva IDs y sustituye carta; filtra agotados y categorías vacías", async () => {
  const res = await put();
  assert.equal(res.status, 200);
  const cat = res.body.categorias[0], p = cat.platos[0];
  for (const id of [cat.id, p.id]) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/);
  assert.equal(p.foto, null);
  assert.ok(Date.parse(res.body.actualizada));
  const cambio = { categorias: [{ ...cat, platos: [ { ...p, precio: 10.01 }, plato({ id: "agotado", disponible: false }) ] },
    { id: "vacia", nombre: "Vacía", platos: [plato({ id: "otro", disponible: false })] }] };
  assert.equal((await put(cambio)).status, 200);
  const publica = await request(app).get("/v1/cartas/r1");
  assert.equal(publica.status, 200);
  assert.equal(publica.body.categorias.length, 1);
  assert.deepEqual(publica.body.categorias[0].platos, [{ ...p, precio: 10.01 }]);
  const editor = await request(app).get("/v1/cartas/r1/editar").set(auth(tokens.empresa));
  assert.equal(editor.body.categorias.length, 2);
  assert.equal(editor.body.categorias[0].platos.length, 2);
});

test("editor y PUT exigen token, rol y propiedad; admin autorizado", async () => {
  for (const method of ["get", "put"]) {
    const url = `/v1/cartas/r1${method === "get" ? "/editar" : ""}`;
    for (const [token, status] of [[null, 401], [tokens.invalid, 401], [tokens.cliente, 403]]) {
      let req = request(app)[method](url); if (token) req = req.set(auth(token));
      assert.equal((await req.send(carta())).status, status);
    }
    assert.equal((await request(app)[method](url.replace("r1", "r2")).set(auth(tokens.empresa)).send(carta())).status, 403);
    assert.equal((await request(app)[method](url).set(auth(tokens.admin)).send(carta())).status, 200);
  }
});

test("validación de límites, importes, foto HTTPS, alérgenos, booleanos y campos extra", async () => {
  const invalidos = [
    { categorias: [] }, { categorias: Array.from({ length: 31 }, () => ({ nombre: "C", platos: [] })) },
    { categorias: [{ nombre: "", platos: [] }] },
    ...[{ precio: 0 }, { precio: 1000 }, { precio: 1.001 }, { precio: "9.5" }, { nombre: " " }, { nombre: "x".repeat(81) },
      { descripcion: "x".repeat(301) }, { foto: "http://example.test/a" }, { foto: "no-url" }, { alergenos: ["inventado"] },
      { disponible: "true" }, { id: "con.punto" }, { id: "x".repeat(41) }, { restauranteId: "r2" }]
      .map(extra => ({ categorias: [{ nombre: "C", platos: [plato(extra)] }] })),
    { categorias: [{ nombre: "C", platos: Array.from({ length: 61 }, () => plato()) }] },
    { categorias: Array.from({ length: 6 }, () => ({ nombre: "C", platos: Array.from({ length: 51 }, () => plato()) })) },
  ];
  for (const body of invalidos) {
    const res = await put(body); assert.equal(res.status, 400, JSON.stringify(body).slice(0, 160));
    assert.equal(res.body.error, "VALIDATION_ERROR");
  }
  assert.equal(store.get("cartas")?.size || 0, 0);
});

test("rechaza IDs de categorías repetidos y platos repetidos entre categorías", async () => {
  for (const body of [
    { categorias: [{ id: "c", nombre: "A", platos: [] }, { id: "c", nombre: "B", platos: [] }] },
    { categorias: [{ nombre: "A", platos: [plato({ id: "p" }), plato({ id: "p" })] }] },
    { categorias: [{ nombre: "A", platos: [plato({ id: "p" })] }, { nombre: "B", platos: [plato({ id: "p" })] }] },
  ]) assert.equal((await put(body)).status, 400);
});
