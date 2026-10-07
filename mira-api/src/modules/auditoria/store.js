/**
 * Copia en memoria de la colección `auditoria`, compartida por todas las
 * peticiones del proceso: todos los admins leen los MISMOS agregados.
 *
 * Por qué así (plan gratuito de Firestore: 50.000 lecturas/día):
 * - Se carga entera una vez y después solo se piden los documentos nuevos
 *   (`insertadoEn > último`), como mucho cada SYNC_MS. Los agregados no
 *   vuelven a leer la BD.
 * - Lo que inserta este mismo proceso se añade a la copia al instante
 *   (sin lectura), por eso los eventos reales aparecen en < 10 s.
 * - `insertadoEn` (hora de servidor al guardar) y no `ts` para sincronizar:
 *   la simulación escribe `ts` retroactivos que un filtro por `ts` no vería.
 * - Si cambia `revision` en auditoria_estado (borrados, purga, script
 *   externo), se recarga entera.
 * Los agregados calculados se cachean CACHE_MS por clave periodo+filtros y
 * se invalidan al cambiar la copia.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const COLECCION = "auditoria";
const ESTADO = "auditoria_estado";
const ESTADO_DOC = "global";
const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const SYNC_MS = num(process.env.AUDITORIA_SYNC_MS, 8000);
const CACHE_MS = num(process.env.AUDITORIA_CACHE_MS, 90000);

let eventos = [];
let porId = new Map();
let ultimoInsertado = null;
let revisionCargada = null;
let ultimaSync = 0;
let sincronizando = null;
let generacion = 0; // sube con cada cambio de la copia → invalida la caché de agregados
const cache = new Map();

const aFecha = (v) => (v instanceof Date ? v : v?.toDate ? v.toDate() : v ? new Date(v) : null);

function normalizar(id, d) {
  return { ...d, id, ts: aFecha(d.ts), insertadoEn: aFecha(d.insertadoEn) };
}

function anadirLocal(lista) {
  let cambia = false;
  for (const e of lista) {
    if (!e.ts || porId.has(e.id)) continue;
    porId.set(e.id, e);
    eventos.push(e);
    cambia = true;
    if (e.insertadoEn && (!ultimoInsertado || e.insertadoEn > ultimoInsertado)) ultimoInsertado = e.insertadoEn;
  }
  if (cambia) {
    eventos.sort((a, b) => a.ts - b.ts);
    generacion++;
    cache.clear();
  }
}

function quitarLocal(filtro) {
  const antes = eventos.length;
  eventos = eventos.filter((e) => !filtro(e));
  porId = new Map(eventos.map((e) => [e.id, e]));
  if (eventos.length !== antes) { generacion++; cache.clear(); }
  return antes - eventos.length;
}

async function leerEstado() {
  const doc = await db.collection(ESTADO).doc(ESTADO_DOC).get();
  return doc.exists ? doc.data() : {};
}

async function cargaCompleta() {
  const snap = await db.collection(COLECCION).orderBy("ts", "asc").get();
  eventos = [];
  porId = new Map();
  ultimoInsertado = null;
  anadirLocal(snap.docs.map((d) => normalizar(d.id, d.data())));
  generacion++;
  cache.clear();
}

/** Garantiza que la copia está al día (como mucho una sincronización cada SYNC_MS). */
async function sincronizar({ forzar = false } = {}) {
  if (sincronizando) return sincronizando;
  if (!forzar && Date.now() - ultimaSync < SYNC_MS && revisionCargada !== null) return null;
  sincronizando = (async () => {
    try {
      const estado = await leerEstado();
      const revision = estado.revision ?? 0;
      if (revisionCargada === null || revision !== revisionCargada || forzar) {
        await cargaCompleta();
        revisionCargada = revision;
      } else if (ultimoInsertado) {
        const snap = await db.collection(COLECCION).where("insertadoEn", ">", ultimoInsertado).orderBy("insertadoEn", "asc").get();
        // El mock de tests ignora ">", así que se filtra también aquí.
        anadirLocal(snap.docs.map((d) => normalizar(d.id, d.data())).filter((e) => e.insertadoEn > ultimoInsertado || !porId.has(e.id)));
      }
      ultimaSync = Date.now();
    } catch (err) {
      logger.error({ err: err.message }, "auditoria: sincronización fallida");
      throw err;
    }
  })().finally(() => { sincronizando = null; });
  return sincronizando;
}

async function todos() {
  await sincronizar();
  return eventos;
}

/** Agregado cacheado por clave; se recalcula al cambiar la copia o pasado CACHE_MS. */
async function cacheado(clave, calcular) {
  await sincronizar();
  const hit = cache.get(clave);
  if (hit && hit.generacion === generacion && Date.now() - hit.en < CACHE_MS) return hit.valor;
  const valor = calcular(eventos);
  cache.set(clave, { valor, generacion, en: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return valor;
}

function _reset() {
  eventos = [];
  porId = new Map();
  ultimoInsertado = null;
  revisionCargada = null;
  ultimaSync = 0;
  cache.clear();
}

module.exports = {
  COLECCION, ESTADO, ESTADO_DOC, sincronizar, todos, cacheado, anadirLocal, quitarLocal, leerEstado, normalizar, _reset,
};
