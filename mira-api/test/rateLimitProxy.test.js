const test = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/mockFirebase");
const request = require("supertest");
const app = require("../src/app");
const { clearRateLimits } = require("../src/middlewares/rateLimit");

// Detrás del proxy de Render cada usuario llega con su IP en X-Forwarded-For.
// El cupo global (300/min) debe ser por usuario, no compartido por toda la web.
test("rate limit global: cada IP real tiene su propio cupo detrás del proxy", async () => {
  clearRateLimits();
  for (let i = 0; i < 300; i++) {
    await request(app).get("/v1/restaurants/count").set("X-Forwarded-For", "203.0.113.1");
  }
  const agotada = await request(app).get("/v1/restaurants/count").set("X-Forwarded-For", "203.0.113.1");
  assert.equal(agotada.status, 429, "la IP que abusa se limita");
  const otra = await request(app).get("/v1/restaurants/count").set("X-Forwarded-For", "198.51.100.7");
  assert.notEqual(otra.status, 429, "otra IP no comparte el cupo");
  clearRateLimits();
});
