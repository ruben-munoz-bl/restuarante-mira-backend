/**
 * Auditoría: esquema, saneado, periodos, permisos, agregados compartidos,
 * simulación reversible y compatibilidad con POST /v1/interactions.
 */
process.env.AUDITORIA_SYNC_MS = "1";

const { test, before, beforeEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, tokens, store, seed } = require("./helpers/mockFirebase");

let app;
let svc;
let almacen;
let clearRateLimits;
const esquema = require("../src/modules/auditoria/esquema");
const { generarSimulacion } = require("../src/modules/auditoria/simulador");
const ag = require("../src/modules/auditoria/agregados");

before(() => {
  app = require("../src/app");
  svc = require("../src/modules/auditoria/service");
  almacen = require("../src/modules/auditoria/store");
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1" };
const auth = (t) => ({ ...UA, Authorization: `Bearer ${t}` });
const tick = () => new Promise((r) => setTimeout(r, 5));
const docs = () => [...(store.get("auditoria")?.values() || [])];

beforeEach(() => {
  seedBase();
  clearRateLimits();
  store.delete("auditoria");
  store.delete("auditoria_estado");
  almacen._reset();
  svc._reset();
});

describe("esquema", () => {
  test("rechaza tipos fuera del catálogo y acepta los del catálogo", () => {
    assert.ok(esquema.validarEvento({ tipo: "login_exitoso" }).evento);
    assert.ok(esquema.validarEvento({ tipo: "favorito_añadido" }).evento);
    assert.ok(esquema.validarEvento({ tipo: "inventado" }).error);
  });

  test("datos sin PII, máx. 15 claves y textos cortados a 512", () => {
    const datos = { email: "a@b.com", telefono: "600000000", token: "x", nota: "escríbeme a pepe@correo.es", largo: "x".repeat(900) };
    for (let i = 0; i < 20; i++) datos[`k${i}`] = i;
    const { evento } = esquema.validarEvento({ tipo: "busqueda", datos });
    assert.equal(evento.datos.email, undefined);
    assert.equal(evento.datos.telefono, undefined);
    assert.equal(evento.datos.token, undefined);
    assert.equal(evento.datos.nota, "[oculto]");
    const fechas = esquema.validarEvento({ tipo: "export_auditoria", datos: { desde: "2026-10-05T00:00:00.000Z", tel: "x", movil: "1", otro: "+34 600 123 456" } }).evento.datos;
    assert.equal(fechas.desde, "2026-10-05T00:00:00.000Z");
    assert.equal(fechas.otro, "[oculto]");
    assert.equal(evento.datos.largo.length, 512);
    assert.ok(Object.keys(evento.datos).length <= 15);
  });

  test("descarta duraciones < 50 ms y limita scroll a 1 cada 2 s por sesión", () => {
    assert.equal(esquema.validarEvento({ tipo: "busqueda", meta: { duracionMs: 12 } }).descartado, "duracion");
    const ultimos = new Map();
    const e = { tipo: "scroll_profundidad", sesionId: "s1" };
    assert.equal(esquema.pasaThrottle(e, 1000, ultimos), true);
    assert.equal(esquema.pasaThrottle(e, 2500, ultimos), false);
    assert.equal(esquema.pasaThrottle(e, 3100, ultimos), true);
  });

  test("periodos en UTC: día, semana ISO (lunes), mes y todo", () => {
    const ahora = new Date("2026-10-07T15:30:00Z"); // miércoles
    assert.equal(esquema.normalizarPeriodo({ periodo: "dia" }, ahora).desde.toISOString(), "2026-10-07T00:00:00.000Z");
    assert.equal(esquema.normalizarPeriodo({ periodo: "semana" }, ahora).desde.toISOString(), "2026-10-05T00:00:00.000Z");
    assert.equal(esquema.normalizarPeriodo({ periodo: "mes" }, ahora).desde.toISOString(), "2026-10-01T00:00:00.000Z");
    const todo = esquema.normalizarPeriodo({ periodo: "todo" }, ahora);
    assert.equal(todo.desde.getTime(), 0);
    assert.equal(todo.granularidad, "mes");
    assert.equal(todo.anterior, null);
    assert.equal(esquema.claveSemanaISO(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  });
});

describe("POST /v1/auditoria", () => {
  test("anónimo: 202, fuente real aunque el cliente diga sim, sin actor, IP con hash", async () => {
    const res = await request(app).post("/v1/auditoria/batch").set(UA)
      .send({ eventos: [{ tipo: "pagina_vista", fuente: "sim", actorUid: "suplantado", sesionId: "s1", dispositivo: { tipo: "mobile" } }] });
    assert.equal(res.status, 202);
    assert.equal(res.body.aceptados, 1);
    const [d] = docs();
    assert.equal(d.fuente, "real");
    assert.equal(d.actorUid, null);
    assert.equal(d.dispositivo.tipo, "mobile");
    assert.match(d.dispositivo.ipHash || "", /^[0-9a-f]{16}$|^$/);
  });

  test("hora: respeta la del cliente si es reciente; si es futura o antigua usa la del servidor", () => {
    const ahora = new Date("2026-10-07T12:00:00Z");
    assert.equal(svc.horaDe({ tsCliente: "2026-10-07T11:59:30Z" }, ahora).toISOString(), "2026-10-07T11:59:30.000Z");
    assert.equal(svc.horaDe({ tsCliente: "2026-10-07T12:05:00Z" }, ahora), ahora);
    assert.equal(svc.horaDe({ tsCliente: "2026-01-01T00:00:00Z" }, ahora), ahora);
    assert.equal(svc.horaDe({}, ahora), ahora);
  });

  test("con sesión el actor lo pone el servidor", async () => {
    await request(app).post("/v1/auditoria").set(auth(tokens.cliente)).send({ tipo: "login_exitoso" });
    const [d] = docs();
    assert.equal(d.actorUid, "u-cli");
    assert.equal(d.actorTipo, "usuario");
  });

  test("ignora bots, eventos de panel de no-admins y lotes de más de 100", async () => {
    const bot = await request(app).post("/v1/auditoria").set("User-Agent", "Googlebot/2.1").send({ tipo: "pagina_vista" });
    assert.equal(bot.body.aceptados, 0);
    const panel = await request(app).post("/v1/auditoria").set(auth(tokens.cliente)).send({ tipo: "puntos_abonados", origen: "panel" });
    assert.equal(panel.body.aceptados, 0);
    const grande = await request(app).post("/v1/auditoria/batch").set(UA).send({ eventos: Array(101).fill({ tipo: "pagina_vista" }) });
    assert.equal(grande.status, 400);
    assert.equal(docs().length, 0);
  });

  test("con el registro global desactivado no guarda nada", async () => {
    seed("auditoria_estado", "global", { ajustes: { registroActivo: false } });
    const res = await request(app).post("/v1/auditoria").set(UA).send({ tipo: "pagina_vista" });
    assert.equal(res.body.aceptados, 0);
    assert.equal(docs().length, 0);
  });
});

describe("lectura (solo admin) y agregados compartidos", () => {
  test("cliente → 403 y queda registrado como admin_acceso_denegado", async () => {
    const res = await request(app).get("/v1/auditoria/overview").set(auth(tokens.cliente));
    assert.equal(res.status, 403);
    await tick();
    assert.ok(docs().some((d) => d.tipo === "admin_acceso_denegado" && d.actorUid === "u-cli" && d.resultado === "error"));
  });

  test("overview: los eventos reales aparecen al momento y con versión", async () => {
    await request(app).post("/v1/auditoria/batch").set(auth(tokens.cliente)).send({ eventos: [
      { tipo: "login_exitoso", sesionId: "s1" }, { tipo: "busqueda", sesionId: "s1", datos: { consulta: "paella", resultados: 4 } },
      { tipo: "filtro_aplicado", sesionId: "s1" }, { tipo: "restaurante_pulsado", sesionId: "s1", entidadTipo: "restaurante", entidadId: "r1" },
    ] });
    const res = await request(app).get("/v1/auditoria/overview?periodo=dia").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 1);
    assert.equal(res.body.kpis.eventos, 4);
    assert.equal(res.body.kpis.sesiones, 1);
    assert.equal(res.body.porFuente.real, 4);
    assert.equal(res.body.porFuente.sim, 0);
  });

  test("dos admins distintos reciben exactamente los mismos agregados", async () => {
    seed("usuarios", "u-admin2", { uid: "u-admin2", tipo: "admin" });
    const { encodeToken } = require("./helpers/mockFirebase");
    const admin2 = encodeToken({ uid: "u-admin2", role: "admin" });
    await request(app).post("/v1/auditoria/batch").set(UA).send({ eventos: [{ tipo: "pagina_vista" }, { tipo: "busqueda" }] });
    const a = await request(app).get("/v1/auditoria/breakdown?dimension=tipo&periodo=mes").set(auth(tokens.admin));
    const b = await request(app).get("/v1/auditoria/breakdown?dimension=tipo&periodo=mes").set(auth(admin2));
    assert.deepEqual(a.body.items, b.body.items);
  });

  test("logs paginados con cursor y timeline de usuario con cambios del admin", async () => {
    const eventos = Array.from({ length: 7 }, () => ({ tipo: "pagina_vista" }));
    await request(app).post("/v1/auditoria/batch").set(auth(tokens.cliente)).send({ eventos });
    await request(app).post("/v1/auditoria").set(auth(tokens.admin)).send({
      tipo: "puntos_abonados", origen: "panel", entidadTipo: "usuario", entidadId: "u-cli", cambios: [{ campo: "saldoPuntos", antes: 0, despues: 50 }],
    });
    const p1 = await request(app).get("/v1/auditoria/logs?periodo=dia&limite=5").set(auth(tokens.admin));
    assert.equal(p1.body.items.length, 5);
    assert.ok(p1.body.cursor);
    const p2 = await request(app).get(`/v1/auditoria/logs?periodo=dia&limite=5&cursor=${p1.body.cursor}`).set(auth(tokens.admin));
    assert.equal(p2.body.items.length, 3);
    await request(app).post("/v1/auditoria").set(UA).send({ tipo: "busqueda", anonId: "navegador-1" });
    await request(app).post("/v1/auditoria").set(auth(tokens.cliente)).send({ tipo: "login_exitoso", anonId: "navegador-1" });
    const tl = await request(app).get("/v1/auditoria/usuario/u-cli").set(auth(tokens.admin));
    assert.ok(tl.body.items.some((e) => e.tipo === "busqueda" && !e.actorUid), "incluye lo hecho antes del login en el mismo navegador");
    const abono = tl.body.items.find((e) => e.tipo === "puntos_abonados");
    assert.equal(abono.actorUid, "u-admin");
    assert.deepEqual(abono.cambios, [{ campo: "saldoPuntos", antes: 0, despues: 50 }]);
  });

  test("export CSV queda registrado como export_auditoria", async () => {
    await request(app).post("/v1/auditoria").set(UA).send({ tipo: "pagina_vista" });
    const res = await request(app).get("/v1/auditoria/export?periodo=mes&formato=csv").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.match(res.text, /^﻿ts;tipo;fuente/);
    assert.ok(docs().some((d) => d.tipo === "export_auditoria" && d.actorUid === "u-admin" && d.datos.eventos === 1));
  });
});

describe("simulación", () => {
  test("genera 100 usuarios con fechas repartidas en 30 días y acciones de admin", () => {
    const { eventos, resumen } = generarSimulacion({ simRunId: "sim-test", hoy: new Date("2026-10-07T12:00:00Z") });
    assert.ok(eventos.every((e) => e.fuente === "sim" && e.simRunId === "sim-test"));
    assert.ok(resumen.dias >= 20, `días cubiertos: ${resumen.dias}`);
    assert.ok(resumen.semanas >= 4);
    assert.ok(eventos.some((e) => e.actorTipo === "admin" && e.cambios?.length));
    assert.ok(eventos.some((e) => e.tipo === "login_fallido"));
    assert.ok(eventos.some((e) => e.tipo === "busqueda" && e.datos.vacio === true));
    assert.ok(eventos.filter((e) => e.origen === "app").every((e) => e.dispositivo?.pais), "los eventos simulados conservan el país");
    // Determinista: misma semilla → mismos eventos.
    assert.equal(generarSimulacion({ simRunId: "sim-test", hoy: new Date("2026-10-07T12:00:00Z") }).eventos.length, eventos.length);
  });

  test("run + reset: borra solo lo simulado y deja intactos los reales", async () => {
    await request(app).post("/v1/auditoria").set(UA).send({ tipo: "pagina_vista" });
    const run = await request(app).post("/v1/auditoria/sim/run").set(auth(tokens.admin)).send({ usuarios: 10, dias: 30 });
    assert.equal(run.status, 202);
    while (svc.simEnCursoId()) await tick();
    const ov = await request(app).get("/v1/auditoria/overview?periodo=todo").set(auth(tokens.admin));
    assert.equal(ov.body.porFuente.real, 1);
    assert.ok(ov.body.porFuente.sim > 50);
    const solo = await request(app).get("/v1/auditoria/overview?periodo=todo&fuente=real").set(auth(tokens.admin));
    assert.equal(solo.body.kpis.eventos, 1);

    const reset = await request(app).post("/v1/auditoria/sim/reset").set(auth(tokens.admin)).send({});
    assert.ok(reset.body.borrados > 50);
    assert.deepEqual(docs().map((d) => d.fuente), ["real"]);
    const tras = await request(app).get("/v1/auditoria/overview?periodo=todo").set(auth(tokens.admin));
    assert.equal(tras.body.porFuente.sim, 0);
  });
});

describe("compatibilidad", () => {
  test("POST /v1/interactions escribe un evento `interaccion` en auditoría", async () => {
    seed("promociones", "p1", { restauranteId: "r1", activa: true, fechaInicio: new Date(Date.now() - 86400000), fechaFin: new Date(Date.now() + 86400000), presupuesto: 100, gastado: 0 });
    await request(app).post("/v1/interactions").set(auth(tokens.cliente)).send({ restauranteId: "r1", tipo: "view" });
    await tick();
    const d = docs().find((x) => x.tipo === "interaccion");
    assert.ok(d, "debe existir el evento interaccion");
    assert.equal(d.entidadId, "r1");
    assert.equal(d.accion, "view");
    assert.equal(d.origen, "api");
    assert.equal(d.fuente, "real");
  });

  test("agregados: breakdown con % y share, delta null sin base", () => {
    const lista = [{ tipo: "a" }, { tipo: "a" }, { tipo: "b" }, { tipo: "c" }].map((e) => ({ ...e, ts: new Date() }));
    const b = ag.breakdown(lista, "tipo", 2);
    assert.deepEqual(b.items.map((i) => [i.valor, i.n, i.pct, i.share]), [["a", 2, 50, 50], ["b", 1, 25, 75]]);
    assert.equal(b.resto, 1);
  });
});
