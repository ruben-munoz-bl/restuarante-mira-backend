/**
 * /v1/auditoria — escritura best-effort (cualquiera, con o sin sesión) y
 * lectura/export solo admin. Los agregados salen de la copia compartida de
 * store.js, así todos los admins ven exactamente lo mismo.
 */
const { Router } = require("express");
const { z } = require("zod");
const { verifyFirebaseAuth, optionalAuth, authorize } = require("../../middlewares/verifyFirebaseAuth");
const { asyncHandler } = require("../../middlewares/errorHandler");
const { validate } = require("../../middlewares/validate");
const { rateLimit } = require("../../middlewares/rateLimit");
const store = require("./store");
const svc = require("./service");
const ag = require("./agregados");
const { batchSchema, normalizarPeriodo } = require("./esquema");

const router = Router();
const soloAdmin = [verifyFirebaseAuth, authorize("admin")];

/* ───────── Escritura ───────── */

router.post("/", rateLimit(60000, 240), optionalAuth, asyncHandler(async (req, res) => {
  const r = await svc.insertarReales([req.body], svc.contextoDe(req));
  res.status(202).json(r);
}));

router.post("/batch", rateLimit(60000, 120), optionalAuth, validate(batchSchema), asyncHandler(async (req, res) => {
  const r = await svc.insertarReales(req.validated.eventos, svc.contextoDe(req));
  res.status(202).json(r);
}));

/* ───────── Lectura (admin) ───────── */

function rangoDe(q) {
  return normalizarPeriodo({ periodo: q.periodo, desde: q.desde, hasta: q.hasta, granularidad: q.granularidad });
}

const FILTROS = ["fuente", "tipos", "categoria", "origen", "resultado", "actorUid", "actorTipo", "entidadId", "dispositivo", "buscar"];
function filtrosDe(q) {
  return Object.fromEntries(FILTROS.filter((k) => q[k]).map((k) => [k, String(q[k]).slice(0, 200)]));
}

function clave(nombre, q) {
  return `${nombre}?${Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&")}`;
}

/** Cabecera común: versión del esquema y revisión, para que el cliente avise si cambian. */
async function meta(rango) {
  const est = await svc.estado();
  return {
    version: est.versionEsquema,
    revision: est.revision,
    periodo: rango.periodo,
    desde: rango.desde.toISOString(),
    hasta: rango.hasta.toISOString(),
    granularidad: rango.granularidad,
    generadoEn: new Date().toISOString(),
  };
}

router.get("/overview", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const datos = await store.cacheado(clave("overview", req.query), (todos) => ag.overview(todos, rango, filtrosDe(req.query)));
  res.json({ ...(await meta(rango)), ...datos });
}));

router.get("/series", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const datos = await store.cacheado(clave("series", req.query), (todos) => ag.series(todos, rango, filtrosDe(req.query), req.query.metrica || "eventos"));
  res.json({ ...(await meta(rango)), ...datos });
}));

router.get("/breakdown", ...soloAdmin, asyncHandler(async (req, res) => {
  const dimension = ag.DIMENSIONES.includes(req.query.dimension) ? req.query.dimension : "tipo";
  const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 50);
  const rango = rangoDe(req.query);
  const datos = await store.cacheado(clave("breakdown", req.query), (todos) =>
    ag.breakdown(ag.filtrar(ag.enRango(todos, rango.desde, rango.hasta), filtrosDe(req.query)), dimension, top));
  res.json({ ...(await meta(rango)), ...datos });
}));

/** Extra de la sub-pestaña Actividad: mapa de calor día×hora y embudos. */
router.get("/actividad", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const datos = await store.cacheado(clave("actividad", req.query), (todos) => {
    const lista = ag.filtrar(ag.enRango(todos, rango.desde, rango.hasta), filtrosDe(req.query));
    return { calor: ag.calor(lista), funnels: ag.funnels(lista) };
  });
  res.json({ ...(await meta(rango)), ...datos });
}));

router.get("/usuarios", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const datos = await store.cacheado(clave("usuarios", req.query), (todos) =>
    ag.usuarios(ag.filtrar(ag.enRango(todos, rango.desde, rango.hasta), filtrosDe(req.query))).slice(0, 500));
  res.json({ ...(await meta(rango)), items: datos });
}));

router.get("/logs", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const todos = await store.todos();
  const lista = ag.filtrar(ag.enRango(todos, rango.desde, rango.hasta), filtrosDe(req.query));
  res.json({ ...(await meta(rango)), ...ag.paginar(lista, { limite: req.query.limite, cursor: req.query.cursor }) });
}));

async function timeline(req, res) {
  const uid = req.params.uid || null;
  const entidadId = req.query.entidadId || null;
  if (!uid && !entidadId) return res.status(400).json({ error: "VALIDATION_ERROR", message: "uid o entidadId requerido" });
  const todos = await store.todos();
  // También lo que hizo ese navegador antes de identificarse (mismo anonId).
  const anonIds = uid ? new Set(todos.filter((e) => e.actorUid === uid && e.anonId).map((e) => e.anonId)) : new Set();
  const items = todos
    .filter((e) => (uid && (e.actorUid === uid || (e.entidadTipo === "usuario" && e.entidadId === uid) || (!e.actorUid && anonIds.has(e.anonId))))
      || (entidadId && e.entidadId === entidadId))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 1000);
  res.json({ uid, entidadId, total: items.length, items });
}
router.get("/usuario/:uid", ...soloAdmin, asyncHandler(timeline));
router.get("/usuario", ...soloAdmin, asyncHandler(timeline));

/* ───────── Export ───────── */

const COLUMNAS = ["ts", "tipo", "fuente", "origen", "resultado", "actorTipo", "actorUid", "actorNombre", "entidadTipo", "entidadId",
  "entidadNombre", "pagina", "ruta", "accion", "sesionId", "dispositivo.tipo", "dispositivo.os", "dispositivo.navegador", "pais",
  "codigoError", "cambios", "datos", "simRunId"];

function celda(v) {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/export", ...soloAdmin, asyncHandler(async (req, res) => {
  const rango = rangoDe(req.query);
  const formato = req.query.formato === "json" ? "json" : "csv";
  const filtros = filtrosDe(req.query);
  const todos = await store.todos();
  const lista = ag.filtrar(ag.enRango(todos, rango.desde, rango.hasta), filtros).sort((a, b) => a.ts - b.ts);
  if (req.query.estimar === "1") return res.json({ eventos: lista.length, bytesAprox: lista.length * (formato === "json" ? 700 : 320) });

  await svc.registrarServidor(req, {
    tipo: "export_auditoria", origen: "panel", entidadTipo: "auditoria", accion: formato,
    datos: { periodo: rango.periodo, desde: rango.desde.toISOString(), hasta: rango.hasta.toISOString(), eventos: lista.length, ...filtros },
  });

  const nombre = `auditoria_${rango.periodo}_${new Date().toISOString().slice(0, 10)}.${formato}`;
  res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
  if (formato === "json") {
    res.type("application/json").send(JSON.stringify({ ...(await meta(rango)), filtros, total: lista.length, eventos: lista }));
    return;
  }
  const filas = lista.map((e) => COLUMNAS.map((c) => celda(c === "pais" ? e.dispositivo?.pais : c.startsWith("dispositivo.") ? e.dispositivo?.[c.slice(12)] : e[c])).join(";"));
  res.type("text/csv; charset=utf-8").send(`﻿${COLUMNAS.join(";")}\n${filas.join("\n")}`);
}));

/* ───────── Estado, ajustes, simulación y purga (admin) ───────── */

router.get("/estado", ...soloAdmin, asyncHandler(async (req, res) => {
  const est = await svc.estado({ fresco: true });
  const todos = await store.todos();
  res.json({ ...est, totales: { eventos: todos.length, real: todos.filter((e) => e.fuente === "real").length, sim: todos.filter((e) => e.fuente === "sim").length } });
}));

const ajustesSchema = z.object({ registroActivo: z.boolean().optional(), excluirPropio: z.boolean().optional() });
router.put("/ajustes", ...soloAdmin, validate(ajustesSchema), asyncHandler(async (req, res) => {
  const antes = (await svc.estado({ fresco: true })).ajustes;
  const ajustes = { ...antes, ...req.validated };
  await svc.guardarEstado({ ajustes });
  // Se registra aunque el registro global quede apagado: apagarlo también es una acción auditable.
  const cambios = Object.keys(req.validated).filter((k) => antes[k] !== ajustes[k]).map((k) => ({ campo: k, antes: antes[k], despues: ajustes[k] }));
  if (cambios.length) {
    await svc.registrarServidor(req, { tipo: "ajustes_cambiados", origen: "panel", entidadTipo: "ajustes", entidadId: "auditoria", cambios }, { forzar: true });
  }
  res.json({ ajustes });
}));

router.get("/sim/estado", ...soloAdmin, asyncHandler(async (req, res) => {
  const est = await svc.estado({ fresco: true });
  res.json({ simRunId: est.simRunId, sim: est.sim, enCurso: svc.simEnCursoId() });
}));

router.post("/sim/run", ...soloAdmin, validate(z.object({ usuarios: z.number().int().min(1).max(500).optional(), dias: z.number().int().min(1).max(365).optional() }).default({})), asyncHandler(async (req, res) => {
  const r = await svc.simular(req.validated || {});
  res.status(202).json(r);
}));

router.post("/sim/reset", ...soloAdmin, asyncHandler(async (req, res) => {
  const r = await svc.limpiarSimulacion(req.body?.simRunId || null);
  res.json(r);
}));

router.post("/purge", ...soloAdmin, asyncHandler(async (req, res) => {
  const anios = Number(req.query.anios);
  if (!Number.isFinite(anios) || anios < 1) return res.status(400).json({ error: "VALIDATION_ERROR", message: "anios >= 1 requerido" });
  if (req.body?.confirmacion !== "PURGAR") return res.status(400).json({ error: "CONFIRMACION_REQUERIDA", message: "Envía { confirmacion: 'PURGAR' }" });
  const r = await svc.purgar(anios);
  res.json(r);
}));

module.exports = router;
