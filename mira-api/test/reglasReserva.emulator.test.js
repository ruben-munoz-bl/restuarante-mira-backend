// Pruebas contra el motor real de reglas, no el mock de Firebase del resto de la suite.
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = "demo-mira-m04";
const base = host ? `http://${host}` : null;
const root = `/v1/projects/${project}/databases/(default)/documents`;
function token(uid) {
  const encode = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: uid, user_id: uid, aud: project,
    iss: `https://securetoken.google.com/${project}`, iat, exp: iat + 3600, auth_time: iat,
    firebase: { sign_in_provider: "custom", identities: {} } })}.`;
}
async function call(method, ruta, uid, fields) {
  const headers = { "Content-Type": "application/json" };
  if (uid) headers.Authorization = `Bearer ${uid === "owner" ? "owner" : token(uid)}`;
  return fetch(`${base}${root}/${ruta}`, { method, headers, ...(fields ? { body: JSON.stringify({ fields }) } : {}) });
}
const fields = { uid: { stringValue: "cliente" }, fecha: { stringValue: "2026-10-22" }, hora: { stringValue: "13:00" }, comensales: { integerValue: "2" } };

test("M04 reglas Firestore: reservas, cartas y movimientos", { skip: !host && "Requiere emulador local de Firestore" }, async t => {
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d+$/, "Solo se admite el emulador local");
  const content = fs.readFileSync(path.join(__dirname, "../firestore.rules"), "utf8");
  const compile = await fetch(`${base}/emulator/v1/projects/${project}:securityRules`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
  });
  assert.equal(compile.status, 200, await compile.text());
  for (const [uid, tipo] of [["admin", "admin"], ["empresa", "empresa"], ["cliente", "cliente"], ["ajeno", "cliente"]]) {
    assert.equal((await call("PATCH", `usuarios/${uid}`, "owner", { tipo: { stringValue: tipo } })).status, 200);
  }
  assert.equal((await call("PATCH", "reservas/res1", "owner", fields)).status, 200);
  assert.equal((await call("PATCH", "cartas/r1", "owner", { restauranteId: { stringValue: "r1" } })).status, 200);
  assert.equal((await call("PATCH", "puntos_movimientos/m1", "owner", { uid: { stringValue: "cliente" }, puntos: { integerValue: "50" } })).status, 200);

  await t.test("reserva: solo titular/admin leen, ningún cliente escribe ni borra", async () => {
    for (const [uid, status] of [["cliente", 200], ["admin", 200], ["empresa", 403], ["ajeno", 403], [null, 403]]) {
      assert.equal((await call("GET", "reservas/res1", uid)).status, status, `leer ${uid}`);
      assert.equal((await call("PATCH", `reservas/nueva_${uid}`, uid, fields)).status, 403, `crear ${uid}`);
      for (const campo of ["pedido", "presentadaEn", "puntosPedido", "uid"]) {
        assert.equal((await call("PATCH", `reservas/res1?updateMask.fieldPaths=${campo}`, uid, { [campo]: { stringValue: "alterado" } })).status, 403, `editar ${campo} ${uid}`);
      }
      assert.equal((await call("DELETE", "reservas/res1", uid)).status, 403, `borrar ${uid}`);
    }
  });
  await t.test("cartas: lectura y escritura directa cerradas para todos los roles", async () => {
    for (const uid of ["cliente", "admin", "empresa", "ajeno", null]) {
      assert.equal((await call("GET", "cartas/r1", uid)).status, 403);
      assert.equal((await call("PATCH", "cartas/r1", uid, {})).status, 403);
      assert.equal((await call("PATCH", `cartas/nueva_${uid}`, uid, {})).status, 403);
      assert.equal((await call("DELETE", "cartas/r1", uid)).status, 403);
    }
  });
  await t.test("movimientos: solo titular/admin leen; create/update/delete siempre denegados", async () => {
    for (const [uid, status] of [["cliente", 200], ["admin", 200], ["empresa", 403], ["ajeno", 403], [null, 403]]) {
      assert.equal((await call("GET", "puntos_movimientos/m1", uid)).status, status);
      assert.equal((await call("PATCH", `puntos_movimientos/nuevo_${uid}`, uid, fields)).status, 403);
      assert.equal((await call("PATCH", "puntos_movimientos/m1", uid, fields)).status, 403);
      assert.equal((await call("DELETE", "puntos_movimientos/m1", uid)).status, 403);
    }
  });
});
