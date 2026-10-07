/**
 * Auditoría: historial append-only en la colección `auditoria`.
 * - Solo se inserta. Los únicos borrados son la limpieza de una simulación
 *   (fuente:'sim' + simRunId) y la purga por retención que pide un admin.
 * - `fuente` la decide el servidor: todo lo que llega por la API es 'real';
 *   'sim' solo lo escribe el simulador.
 * - Actor, IP (con hash), país y hora salen del servidor, nunca del cliente.
 */
const crypto = require("crypto");
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const store = require("./store");
const { validarEvento, pasaThrottle, esBot } = require("./esquema");
const { generarSimulacion, escribirEnLotes, limpiarUndefined } = require("./simulador");

const VERSION_ESQUEMA = 1;
const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const MAX_DIA = num(process.env.AUDITORIA_MAX_DIA, 8000);
const SAL_IP = process.env.AUDITORIA_IP_SALT || process.env.LOGS_IP_SALT || "mira-auditoria";
const IPS_PROPIAS = new Set(String(process.env.AUDITORIA_IPS_PROPIAS || "").split(",").map((s) => s.trim()).filter(Boolean));
const ESTADO_TTL_MS = 30000;

const ultimosScroll = new Map();
let cuota = { dia: "", n: 0 };
let estadoCache = { valor: null, en: 0 };
let simEnCurso = null;

const AJUSTES_DEFECTO = { registroActivo: true, excluirPropio: false };

function hashIp(ip) {
  return ip ? crypto.createHash("sha256").update(`${SAL_IP}:${ip}`).digest("hex").slice(0, 16) : null;
}

function actorTipoDe(role) {
  if (role === "admin") return "admin";
  if (role === "empresa") return "empresa";
  return "usuario";
}

/** Estado/ajustes compartidos (auditoria_estado/global), cacheados 30 s. */
async function estado({ fresco = false } = {}) {
  if (!fresco && estadoCache.valor && Date.now() - estadoCache.en < ESTADO_TTL_MS) return estadoCache.valor;
  const datos = await store.leerEstado();
  const valor = {
    versionEsquema: datos.versionEsquema ?? VERSION_ESQUEMA,
    revision: datos.revision ?? 0,
    ajustes: { ...AJUSTES_DEFECTO, ...(datos.ajustes || {}) },
    simRunId: datos.simRunId || null,
    sim: datos.sim || null,
    contadores: datos.contadores || {},
    ultimoBackup: datos.ultimoBackup || null,
  };
  estadoCache = { valor, en: Date.now() };
  return valor;
}

async function guardarEstado(parche, { subirRevision = false } = {}) {
  const ref = db.collection(store.ESTADO).doc(store.ESTADO_DOC);
  const actual = (await ref.get()).data() || {};
  const nuevo = { versionEsquema: VERSION_ESQUEMA, ...actual, ...parche, actualizadoEn: new Date() };
  if (subirRevision) nuevo.revision = (actual.revision || 0) + 1;
  await ref.set(limpiarUndefined(nuevo));
  estadoCache = { valor: null, en: 0 };
  return nuevo;
}

function hayCuota() {
  const dia = new Date().toISOString().slice(0, 10);
  if (cuota.dia !== dia) cuota = { dia, n: 0, avisado: false };
  if (cuota.n < MAX_DIA) return true;
  if (!cuota.avisado) { cuota.avisado = true; logger.warn({ max: MAX_DIA }, "auditoria: tope diario alcanzado"); }
  return false;
}

/** Contexto del servidor para un evento: quién, desde dónde y cuándo. */
function contextoDe(req) {
  const ua = req.headers["user-agent"] || "";
  return {
    user: req.user || null,
    ip: req.ip,
    userAgent: ua,
    pais: (req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "").slice(0, 2) || null,
  };
}

/**
 * Inserta eventos reales llegados del cliente. Best-effort: nunca lanza.
 * Devuelve { aceptados, descartados, motivos }.
 */
async function insertarReales(crudos, ctx) {
  const motivos = {};
  const descartar = (m) => { motivos[m] = (motivos[m] || 0) + 1; };
  let est;
  try { est = await estado(); } catch { est = { ajustes: AJUSTES_DEFECTO }; }
  if (!est.ajustes.registroActivo) return { aceptados: 0, descartados: crudos.length, motivos: { registro_desactivado: crudos.length } };
  if (esBot(ctx.userAgent)) return { aceptados: 0, descartados: crudos.length, motivos: { bot: crudos.length } };
  if (IPS_PROPIAS.has(ctx.ip)) return { aceptados: 0, descartados: crudos.length, motivos: { ip_propia: crudos.length } };

  const ahora = new Date();
  const docs = [];
  for (const crudo of crudos) {
    const v = validarEvento(crudo);
    if (!v.evento) { descartar(v.descartado || "invalido"); continue; }
    const e = v.evento;
    const esAdmin = ctx.user?.role === "admin";
    // "Excluir tráfico propio": la navegación de admins no cuenta; sus ACCIONES sí (son lo que se audita).
    if (est.ajustes.excluirPropio && esAdmin && ["navegacion", "busqueda", "catalogo"].includes(require("./catalogo").CATEGORIA_DE[e.tipo])) { descartar("trafico_propio"); continue; }
    if (!pasaThrottle(e, ahora.getTime(), ultimosScroll)) { descartar("throttle"); continue; }
    if (e.origen === "panel" && !esAdmin) { descartar("panel_sin_admin"); continue; }
    if (!hayCuota()) { descartar("cuota"); continue; }
    cuota.n++;
    docs.push(construir(e, ctx, horaDe(e, ahora)));
  }
  if (docs.length) await escribir(docs);
  const descartados = crudos.length - docs.length;
  return { aceptados: docs.length, descartados, motivos };
}

/**
 * Hora del evento: la del servidor, salvo que la del cliente sea coherente
 * (no futura y como mucho 2 min antes). Así un lote enviado de golpe conserva
 * el orden real de sus eventos sin aceptar fechas manipuladas.
 */
function horaDe(e, ahora) {
  const t = e.tsCliente ? new Date(e.tsCliente).getTime() : NaN;
  if (Number.isFinite(t) && t <= ahora.getTime() && ahora.getTime() - t <= 120000) return new Date(t);
  return ahora;
}

function construir(e, ctx, ahora, extra = {}) {
  const u = ctx.user;
  return limpiarUndefined({
    ...e,
    ts: ahora,
    fuente: "real",
    actorUid: u?.uid || null,
    actorEmail: u?.email || null,
    actorTipo: u ? actorTipoDe(u.role) : null,
    actorNombre: extra.actorNombre ?? null,
    dispositivo: { ...(e.dispositivo || {}), pais: ctx.pais || null, ipHash: hashIp(ctx.ip) },
    ...extra,
  });
}

/** Escribe y añade a la copia compartida al momento (los admins lo ven sin esperar a la sincronización). */
async function escribir(docs) {
  try {
    const escritos = await escribirEnLotes(db, store.COLECCION, docs);
    store.anadirLocal(escritos.map((d) => store.normalizar(d.id, d)));
    return escritos;
  } catch (err) {
    logger.error({ err: err.message, n: docs.length }, "auditoria: no se pudieron guardar eventos");
    return [];
  }
}

/** Evento originado en el propio servidor (acceso denegado, interacciones, export...). */
async function registrarServidor(req, parcial, { forzar = false } = {}) {
  try {
    const est = await estado();
    if ((!est.ajustes.registroActivo && !forzar) || !hayCuota()) return;
    cuota.n++;
    const ctx = req ? contextoDe(req) : { user: null };
    const v = validarEvento({ ...parcial, origen: "app" });
    if (!v.evento) return;
    await escribir([construir(v.evento, ctx, new Date(), { origen: parcial.origen || "api" })]);
  } catch (err) {
    logger.warn({ err: err.message, tipo: parcial.tipo }, "auditoria: evento de servidor no registrado");
  }
}

/* ───────── Simulación ───────── */

async function simular({ usuarios = 100, dias = 30 } = {}) {
  if (simEnCurso) return { enCurso: true, simRunId: simEnCurso };
  const simRunId = `sim-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;
  const { eventos, resumen } = generarSimulacion({ simRunId, usuarios, dias });
  simEnCurso = simRunId;
  await guardarEstado({ simRunId, sim: { simRunId, estado: "en_curso", escritos: 0, total: eventos.length, inicio: new Date(), resumen } });
  (async () => {
    try {
      let ultimo = 0;
      const escritos = await escribirEnLotes(db, store.COLECCION, eventos, (n, total) => {
        if (n - ultimo >= 500 || n === total) {
          ultimo = n;
          guardarEstado({ sim: { simRunId, estado: "en_curso", escritos: n, total, resumen } }).catch(() => {});
        }
      });
      store.anadirLocal(escritos.map((d) => store.normalizar(d.id, d)));
      await guardarEstado({ sim: { simRunId, estado: "completada", escritos: escritos.length, total: eventos.length, fin: new Date(), resumen } });
    } catch (err) {
      logger.error({ err: err.message, simRunId }, "auditoria: simulación fallida");
      await guardarEstado({ sim: { simRunId, estado: "error", mensaje: err.message } }).catch(() => {});
    } finally {
      simEnCurso = null;
    }
  })();
  return { simRunId, total: eventos.length, resumen };
}

/** Borra SOLO documentos fuente:'sim' (de un simRunId o de todos). Nunca toca los reales. */
async function limpiarSimulacion(simRunId = null) {
  let q = db.collection(store.COLECCION).where("fuente", "==", "sim");
  if (simRunId) q = q.where("simRunId", "==", simRunId);
  const snap = await q.get();
  const docs = snap.docs.filter((d) => d.data().fuente === "sim" && (!simRunId || d.data().simRunId === simRunId));
  for (let i = 0; i < docs.length; i += 500) {
    const lote = db.batch();
    docs.slice(i, i + 500).forEach((d) => lote.delete(d.ref || db.collection(store.COLECCION).doc(d.id)));
    await lote.commit();
  }
  store.quitarLocal((e) => e.fuente === "sim" && (!simRunId || e.simRunId === simRunId));
  await guardarEstado({ simRunId: null, sim: { estado: "limpiada", borrados: docs.length, fin: new Date() } }, { subirRevision: true });
  return { borrados: docs.length };
}

/** Purga por retención: borra eventos con ts anterior a hoy − años. */
async function purgar(anios) {
  const limite = new Date(Date.now() - anios * 365 * 86400000);
  const lista = (await store.todos()).filter((e) => e.ts < limite);
  for (let i = 0; i < lista.length; i += 500) {
    const lote = db.batch();
    lista.slice(i, i + 500).forEach((e) => lote.delete(db.collection(store.COLECCION).doc(e.id)));
    await lote.commit();
  }
  store.quitarLocal((e) => e.ts < limite);
  await guardarEstado({}, { subirRevision: true });
  return { borrados: lista.length, limite };
}

function _reset() {
  ultimosScroll.clear();
  cuota = { dia: "", n: 0 };
  estadoCache = { valor: null, en: 0 };
  simEnCurso = null;
}

module.exports = {
  VERSION_ESQUEMA, estado, guardarEstado, insertarReales, registrarServidor, contextoDe, simular, limpiarSimulacion, purgar,
  hashIp, horaDe, _reset, simEnCursoId: () => simEnCurso,
};
