const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fixture = require("./fixtures/cartasFrontend.json");
const exec = promisify(execFile);
const host = process.env.FIRESTORE_EMULATOR_HOST;

test("M14 emulador: CLI dry-run, siembra, repetición y GET público coherente con frontend", { skip: !host && "Requiere emulador local" }, async () => {
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d+$/);
  process.env.PROJECT_ID = "demo-mira-m14";
  // Sin mock de Firebase: Admin SDK, CLI y ruta Express reales contra demo local.
  const app = require("../src/app");
  const { db } = require("../src/middlewares/verifyFirebaseAuth");
  const request = require("supertest");
  try {
    await fetch(`http://${host}/emulator/v1/projects/demo-mira-m14/databases/(default)/documents`, { method: "DELETE" });
    const muestras = [fixture.muestras[0], fixture.muestras[3], fixture.muestras[12]];
    for (const { restaurante } of muestras) await db.collection("restaurants").doc(restaurante.id).set(restaurante);
    await db.collection("restaurants").doc("_catalogo").set({ _tipo: "catalogo" });
    const protegida = { restauranteId: muestras[0].restaurante.id, categorias: [], actualizada: "editor" };
    await db.collection("cartas").doc(protegida.restauranteId).set(protegida);
    const cli = async dryRun => {
      const args = [path.join(__dirname, "../scripts/sembrarCartas.js"), "--project", "demo-mira-m14", ...(dryRun ? ["--dry-run"] : [])];
      const { stdout } = await exec(process.execPath, args, { env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "" } });
      return JSON.parse(stdout.trim());
    };
    const plan = await cli(true); assert.equal(plan.planificadas, 2); assert.equal(plan.creadas, 0);
    assert.equal((await db.collection("cartas").get()).size, 1);
    const real = await cli(false); assert.equal(real.creadas, 2); assert.equal(real.existentes, 1); assert.equal(real.tecnicos, 1);
    assert.deepEqual((await db.collection("cartas").doc(protegida.restauranteId).get()).data(), protegida);
    for (const { restaurante, libro } of muestras.slice(1)) {
      const res = await request(app).get(`/v1/cartas/${restaurante.id}`); assert.equal(res.status, 200);
      assert.deepEqual(res.body.categorias.map(c => ({ titulo: c.nombre, platos: c.platos.map(p => ({ nombre: p.nombre, precio: p.precio })) })),
        libro.secciones.map(s => ({ titulo: s.titulo, platos: s.platos.map(p => ({ nombre: p.nombre, precio: p.precio })) })));
      assert.ok(res.body.categorias.every(c => c.platos.every(p => p.disponible === true && p.foto === null)));
    }
    assert.equal((await cli(false)).creadas, 0);
    assert.equal((await db.collection("cartas").get()).size, 3);
  } finally { await db.terminate(); }
});
