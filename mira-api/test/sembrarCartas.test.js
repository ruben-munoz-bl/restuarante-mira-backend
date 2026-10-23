const test = require("node:test");
const assert = require("node:assert/strict");
const { seedBase, seed, store, mockDb } = require("./helpers/mockFirebase");
const { generarCarta, sembrarCartas, opciones, main } = require("../scripts/sembrarCartas");
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

test("CLI sin --produccion solo admite emulador local + proyecto demo explícito", () => {
  assert.deepEqual(opciones(["--dry-run", "--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }), { dryRun: true, project: "demo-mira-m14" });
  for (const [args, env] of [
    [["--project", "restaurante-mira-18e0c"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [["--dry-run", "--project", "demo-mira-m14"], {}],
    [["--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "remoto.example:8080" }],
    [[], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [["--force", "--project", "demo-mira-m14"], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
  ]) assert.throws(() => opciones(args, env));
});

test("producción exige dry-run, proyecto MIRA explícito y ausencia de emulador", () => {
  const args = ["--produccion", "--dry-run", "--project", "restaurante-mira-18e0c"];
  assert.deepEqual(opciones(args, {}), { produccion: true, dryRun: true, confirmar: false, project: "restaurante-mira-18e0c" });
  for (const [argv, entorno] of [
    [["--produccion", "--dry-run", "--confirmar", "--project", "restaurante-mira-18e0c"], {}],
    [["--produccion", "--dry-run"], {}],
    [["--produccion", "--dry-run", "--project", "otro-proyecto"], {}],
    [["--produccion", "--dry-run", "--project", "demo-mira-m14"], {}],
    [args, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [[...args, "--force"], {}],
  ]) assert.throws(() => opciones(argv, entorno));
});

test("plan de producción simulado lista solo cartas ausentes; cero transacciones y escrituras", async () => {
  const existente = { categorias: [], actualizada: "editor" };
  seed("cartas", "r1", existente);
  seed("restaurants", "_catalogo", { _tipo: "catalogo" });
  const antes = JSON.stringify([...store].map(([k, v]) => [k, [...v]]));
  const lineas = []; let cerrada = false;
  test.mock.method(mockDb, "runTransaction", () => { throw new Error("No puede escribir"); });
  await main(["--produccion", "--dry-run", "--project", "restaurante-mira-18e0c"], {
    entorno: {}, escribir: texto => lineas.push(JSON.parse(texto)),
    admin: { initializeApp: opts => {
      assert.equal(opts.projectId, "restaurante-mira-18e0c");
      return { firestore: () => mockDb, delete: async () => { cerrada = true; } };
    } },
  });
  assert.equal(cerrada, true);
  assert.deepEqual(lineas.filter(l => l.accion === "crearia").map(l => l.restauranteId), ["r2", "r3"]);
  assert.ok(lineas.filter(l => l.accion === "crearia").every(l => l.categorias > 0 && l.platos > 0));
  assert.deepEqual(lineas.at(-1), { project: "restaurante-mira-18e0c", dryRun: true, produccion: true,
    leidos: 4, tecnicos: 1, existentes: 1, planificadas: 2, creadas: 0 });
  assert.equal(JSON.stringify([...store].map(([k, v]) => [k, [...v]])), antes);
});

test("producción es dry-run por defecto; escribir exige confirmar sin flags contradictorios", async () => {
  const args = ["--produccion", "--project", "restaurante-mira-18e0c"];
  assert.equal(opciones(args, {}).dryRun, true);
  assert.equal(opciones([...args, "--confirmar"], {}).dryRun, false);
  assert.throws(() => opciones([...args, "--confirmar", "--dry-run"], {}));
  await assert.rejects(sembrarCartas(mockDb, { produccion: true, dryRun: false }), /confirmar/);
  assert.equal((await sembrarCartas(mockDb, { produccion: true })).creadas, 0);
  assert.equal((await sembrarCartas(mockDb, { produccion: true, confirmar: true })).creadas, 3);
  assert.equal((await sembrarCartas(mockDb, { produccion: true, confirmar: true })).creadas, 0);
});
