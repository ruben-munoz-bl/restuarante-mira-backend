const test = require("node:test");
const assert = require("node:assert/strict");
const { calcRachaLogin } = require("../src/modules/points/service");

const HOY = "2026-10-13";

test("primer login: racha 1", () => {
  const r = calcRachaLogin({}, HOY);
  assert.equal(r.dias, 1);
  assert.equal(r.yaReclamado, false);
  assert.equal(r.puntos, 5);
});

test("ya reclamado hoy: no cambia", () => {
  const r = calcRachaLogin({ ultimoLoginDate: HOY, rachaLoginDias: 3 }, HOY);
  assert.equal(r.yaReclamado, true);
  assert.equal(r.dias, 3);
  assert.equal(r.puntos, 0);
});

test("día siguiente: +1", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-12", rachaLoginDias: 3 }, HOY);
  assert.equal(r.dias, 4);
  assert.equal(r.puntos, 14);
});

test("un día saltado con gracia: sigue la racha y suma el día", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-11", rachaLoginDias: 3, graceUsados: 0 }, HOY);
  assert.equal(r.dias, 4);
  assert.equal(r.graceUsados, 1);
});

test("un día saltado sin gracia: reinicia", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-11", rachaLoginDias: 5, graceUsados: 2 }, HOY);
  assert.equal(r.dias, 1);
  assert.equal(r.graceUsados, 0);
});

test("más de un día saltado: reinicia", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-08", rachaLoginDias: 5, graceUsados: 1 }, HOY);
  assert.equal(r.dias, 1);
  assert.equal(r.graceUsados, 0);
});

test("fecha guardada en el futuro: reinicia en vez de sumar", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-20", rachaLoginDias: 4 }, HOY);
  assert.equal(r.dias, 1);
});

test("día 7: ruleta disponible y 0 puntos", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-12", rachaLoginDias: 6 }, HOY);
  assert.equal(r.dias, 7);
  assert.equal(r.dia7Disponible, true);
  assert.equal(r.puntos, 0);
});

test("cambio de horario (octubre): el día siguiente sigue contando como 1", () => {
  const r = calcRachaLogin({ ultimoLoginDate: "2026-10-25", rachaLoginDias: 2 }, "2026-10-26");
  assert.equal(r.dias, 3);
});
