const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, mockDb } = require("./helpers/mockFirebase");
const { generarCarta, sembrarCartas, opciones } = require("../scripts/sembrarCartas");
const { cartaSchema } = require("../src/modules/cartas/logica");
const fixture = require("./fixtures/cartasFrontend.json");
test.beforeEach(() => seedBase());
test.afterEach(() => test.mock.restoreAll());

test("mismas categorías, platos, precios, descripciones y alérgenos que el frontend en72 muestras", () => {
  for (const { restaurante, libro } of fixture.muestras) {
    const carta = generarCarta(restaurante, new Date("2026-10-22T10:00:00Z"));
    assert.ok(cartaSchema.safeParse({ categorias: carta.categorias }).success);
    assert.deepEqual(carta.categorias.map(c => ({ titulo: c.nombre, platos: c.platos.map(({ nombre, precio, descripcion, alergenos }) => ({ nombre, precio, descripcion, alergenos })) })),
      libro.secciones.map(s => ({ titulo: s.titulo, platos: s.platos.map(({ nombre, precio, descripcion, alergenos }) => ({ nombre, precio, descripcion, alergenos })) })));
    assert.deepEqual(generarCarta(restaurante, new Date(carta.actualizada)), carta);
    const ids = new Set();
    for (const c of carta.categorias) for (const p of c.platos) {
      assert.match(p.id, /^[A-Za-z0-9_-]{1,40}$/); assert.ok(!ids.has(p.id)); ids.add(p.id);
      assert.equal(p.disponible, true); assert.equal(p.foto, null);
    }
  }
});

test("dry-run valida y cuenta sin escribir; paginación excluye _catalogo", async () => {
  seed("restaurants", "_catalogo", { _tipo: "catalogo" });
  const antes = JSON.stringify([...store].map(([k,v]) => [k, [...v]]));
  const resumen = await sembrarCartas(mockDb, { dryRun: true, lote: 2 });
  assert.deepEqual(resumen, { leidos: 4, tecnicos: 1, existentes: 0, planificadas: 3, creadas: 0 });
  assert.equal(JSON.stringify([...store].filter(([k]) => k !== "cartas").map(([k,v]) => [k, [...v]])), antes);
  assert.equal(store.get("cartas")?.size || 0, 0);
});

test("siembra cartas ausentes y al repetir conserva todas, incluso las editadas", async () => {
  const real = { restauranteId: "r1", categorias: [{ nombre: "Real", platos: [] }], actualizada: "2020-01-01" };
  seed("cartas", "r1", real);
  assert.equal((await sembrarCartas(mockDb, { lote: 2 })).creadas, 2);
  assert.deepEqual(store.get("cartas").get("r1"), real);
  const antes = JSON.stringify([...store.get("cartas")]);
  assert.equal((await sembrarCartas(mockDb, { lote: 1 })).existentes, 3);
  assert.equal(JSON.stringify([...store.get("cartas")]), antes);
});

test("una carta creada por el editor durante el recorrido se conserva dentro de la transacción", async () => {
  const original = mockDb.runTransaction.bind(mockDb);
  const carta = { restauranteId: "r1", categorias: [], actualizada: "editor" };
  test.mock.method(mockDb, "runTransaction", fn => {
    seed("cartas", "r1", carta); return original(fn);
  });
  const res = await sembrarCartas(mockDb);
  assert.equal(res.existentes, 1); assert.deepEqual(store.get("cartas").get("r1"), carta);
});

test("CLI solo admite emulador local + proyecto demo explícito; producción rechazada incluso en dry-run", () => {
  assert.deepEqual(opciones(["--dry-run", "--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }), { dryRun: true, project: "demo-mira-m14", produccion: false });
  for (const [args, env] of [
    [["--project", "restaurante-mira-18e0c"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [["--dry-run", "--project", "demo-mira-m14"], {}],
    [["--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "remoto.example:8080" }],
    [[], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [["--force", "--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
  ]) assert.throws(() => opciones(args, env));
});

test("--produccion solo con el proyecto real, credencial y sin emulador", () => {
  const cred = { GOOGLE_APPLICATION_CREDENTIALS: "c.json" };
  assert.deepEqual(opciones(["--produccion", "--dry-run", "--project", "restaurante-mira-18e0c"], cred), { project: "restaurante-mira-18e0c", dryRun: true, produccion: true });
  for (const [args, env] of [
    [["--produccion", "--project", "otro-proyecto"], cred],
    [["--produccion", "--project", "restaurante-mira-18e0c"], {}],
    [["--produccion", "--project", "restaurante-mira-18e0c"], { ...cred, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
  ]) assert.throws(() => opciones(args, env));
});
