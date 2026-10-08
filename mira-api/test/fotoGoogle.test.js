/**
 * GET /v1/restaurants/:id/foto: sirve al vuelo la foto verificada de Google
 * Places (sin guardarla), con caché corta y 404 cuando no hay foto válida.
 */
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, seed } = require("./helpers/mockFirebase");

let app;
let fotoGoogle;
let llamadas;
const fetchOriginal = global.fetch;

function respuesta(json, ok = true, status = 200) {
  return { ok, status, json: async () => json };
}

before(() => {
  app = require("../src/app");
  fotoGoogle = require("../src/modules/restaurants/fotoGoogle");
});

beforeEach(() => {
  seedBase();
  fotoGoogle._reset();
  process.env.GOOGLE_PLACES_API_KEY = "clave-de-prueba";
  llamadas = [];
  global.fetch = async (url) => {
    llamadas.push(url);
    if (url.includes("/media?")) return respuesta({ photoUri: "https://lh3.googleusercontent.com/foto-verificada" });
    return respuesta({ photos: [
      { name: "places/abc/photos/otra", widthPx: 800, heightPx: 600, authorAttributions: [{ uri: "https://maps/u/otro" }] },
      { name: "places/abc/photos/buena", widthPx: 1600, heightPx: 1200, authorAttributions: [{ uri: "https://maps/u/ana" }] },
    ] });
  };
  seed("restaurants", "r-google", {
    nombre: "Can Solé",
    imagen_fuente: "google_places",
    imagen_google: { placeId: "abc", autor: "Ana", autorUri: "https://maps/u/ana", ancho: 1600, alto: 1200 },
  });
});

test.after(() => { global.fetch = fetchOriginal; });

test("redirige a la foto verificada (mismo autor y tamaño) y la cachea", async () => {
  const r1 = await request(app).get("/v1/restaurants/r-google/foto");
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.location, "https://lh3.googleusercontent.com/foto-verificada");
  assert.equal(decodeURIComponent(r1.headers["x-foto-autor"]), "Ana");
  assert.ok(llamadas.some((u) => u.includes("places/abc/photos/buena/media")));
  const antes = llamadas.length;
  await request(app).get("/v1/restaurants/r-google/foto");
  assert.equal(llamadas.length, antes, "la segunda vez sale de la caché");
});

test("404 si el restaurante no tiene foto de Google o falta la clave", async () => {
  assert.equal((await request(app).get("/v1/restaurants/r1/foto")).status, 404);
  delete process.env.GOOGLE_PLACES_API_KEY;
  fotoGoogle._reset();
  assert.equal((await request(app).get("/v1/restaurants/r-google/foto")).status, 404);
});

test("si la foto verificada ya no existe en Google no sirve otra sin verificar", async () => {
  global.fetch = async (url) => {
    llamadas.push(url);
    return respuesta({ photos: [{ name: "places/abc/photos/otra", widthPx: 800, heightPx: 600, authorAttributions: [{ uri: "https://maps/u/otro" }] }] });
  };
  const r = await request(app).get("/v1/restaurants/r-google/foto");
  assert.equal(r.status, 404);
  assert.ok(!llamadas.some((u) => u.includes("/media?")));
});

test("si Google falla responde 404 (la tarjeta usa su imagen de respaldo)", async () => {
  global.fetch = async () => respuesta({}, false, 500);
  assert.equal((await request(app).get("/v1/restaurants/r-google/foto")).status, 404);
});
