/**
 * PUT /v1/users/me: el tipo solo puede ser cliente o empresa. Nadie se nombra
 * admin desde su perfil y un admin no pierde el rol por esta vía.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, tokens, store } = require("./helpers/mockFirebase");

const app = require("../src/app");
const tipoDe = (uid) => store.get("usuarios").get(uid).tipo;

beforeEach(() => seedBase());

test("un cliente no puede hacerse admin", async () => {
  const res = await request(app).put("/v1/users/me").set("Authorization", `Bearer ${tokens.cliente}`).send({ tipo: "admin" });
  assert.equal(res.status, 400);
  assert.equal(tipoDe("u-cli"), "cliente");
});

test("registro como empresa: cliente → empresa sí se permite", async () => {
  const res = await request(app).put("/v1/users/me").set("Authorization", `Bearer ${tokens.cliente}`).send({ tipo: "empresa", nombre: "Mi Bar" });
  assert.equal(res.status, 200);
  assert.equal(tipoDe("u-cli"), "empresa");
});

test("un admin no se rebaja a cliente desde su perfil (el resto de campos sí se guardan)", async () => {
  await request(app).put("/v1/users/me").set("Authorization", `Bearer ${tokens.admin}`).send({ tipo: "cliente", nombre: "Admin 2" });
  assert.equal(tipoDe("u-admin"), "admin");
  assert.equal(store.get("usuarios").get("u-admin").nombre, "Admin 2");
});
