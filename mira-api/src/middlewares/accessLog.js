/**
 * Trazabilidad: cada petición a la API (con o sin sesión) queda registrada
 * en la colección `logs`.
 *
 * Organización: los registros se agrupan en "bloques". Un documento de
 * `logs/{autoId}` contiene hasta LOGS_POR_DOC peticiones seguidas:
 *   { desde, hasta, dia, n, uids[], modulos[], errores, registros: [ {...}, ... ] }
 * Firestore cobra y limita por documento escrito, así que 1 doc por bloque
 * en vez de 1 por petición divide las escrituras por ~200 (el plan gratuito
 * da 20.000/día y lo comparten reservas, puntos, etc.).
 * - `uids` y `modulos` (arrays) permiten buscar con array-contains + `desde`.
 * - `registros` no se indexa (indexar arrays de mapas dispara las escrituras
 *   de índice); se filtra al leer el bloque.
 * - `expiraEn` para la política TTL de Firestore (borrado automático).
 * - No se guardan bodies, tokens ni valores de query; la IP va con hash.
 *
 * Protecciones para no saturar la BD:
 * - Se escribe como mucho cada LOGS_FLUSH_MS (o al llenar un bloque), un doc cada vez.
 * - Tope diario de documentos (LOGS_MAX_DOCS_DIA). Al llegar, se deja de escribir
 *   hasta el día siguiente (UTC) y queda avisado en el log del servidor.
 * - Si Firestore falla (cuota, red...), se pausa la escritura LOGS_PAUSA_MS y se
 *   descartan esos registros: nunca se reintenta en bucle ni se bloquea la respuesta.
 * - Buffer en memoria acotado (LOGS_MAX_BUFFER).
 */
const crypto = require("crypto");
const { db, admin } = require("./verifyFirebaseAuth");
const { logger } = require("./errorHandler");

const COLECCION = "logs";
const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
const FLUSH_MS = num(process.env.LOGS_FLUSH_MS, 30000);
const POR_DOC = Math.min(num(process.env.LOGS_POR_DOC, 200), 500); // ~400 B/registro → < 1 MB/doc
const MAX_BUFFER = num(process.env.LOGS_MAX_BUFFER, 5000);
const MAX_DOCS_DIA = num(process.env.LOGS_MAX_DOCS_DIA, 1000);
const PAUSA_MS = num(process.env.LOGS_PAUSA_MS, 10 * 60000);
const TTL_DIAS = num(process.env.LOGS_TTL_DIAS, 90);
const SAL_IP = process.env.LOGS_IP_SALT || "mira-logs";
const EXCLUIDAS = new Set(["/health"]);

let buffer = [];
let descartados = 0;
let escribiendo = null;
let pausadoHasta = 0;
let cuota = { dia: "", docs: 0 };

function activo() {
  return process.env.LOGS_ENABLED !== "false";
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(`${SAL_IP}:${ip}`).digest("hex").slice(0, 16);
}

function moduloDe(url) {
  const m = /^\/v\d+\/([^/?]+)/.exec(url);
  return m ? m[1] : "otros";
}

const recorta = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

/** Si la ruta no pasó por auth pero trae token, saca el uid sin leer la BD. */
async function actorDe(req) {
  if (req.user?.uid) return { uid: req.user.uid, rol: req.user.role || null, anonimo: false };
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) {
    try {
      const d = await admin.auth().verifyIdToken(h.slice(7));
      return { uid: d.uid, rol: null, anonimo: false };
    } catch { /* token inválido o caducado: cuenta como anónimo */ }
  }
  return { uid: null, rol: null, anonimo: true };
}

function encolar(registro) {
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    descartados++;
  }
  buffer.push(registro);
  if (buffer.length >= POR_DOC && !escribiendo) flushLogs();
}

function bloque(registros) {
  const ts = registros.map((r) => r.ts);
  const desde = ts[0];
  return {
    desde,
    hasta: ts[ts.length - 1],
    dia: desde.toISOString().slice(0, 10),
    n: registros.length,
    uids: [...new Set(registros.map((r) => r.uid).filter(Boolean))],
    modulos: [...new Set(registros.map((r) => r.modulo))],
    errores: registros.filter((r) => r.status >= 400).length,
    registros,
    expiraEn: new Date(desde.getTime() + TTL_DIAS * 86400000),
  };
}

/** ¿Se puede escribir un doc más hoy? */
function hayCuota(ahora) {
  const dia = ahora.toISOString().slice(0, 10);
  if (cuota.dia !== dia) cuota = { dia, docs: 0, avisado: false };
  if (cuota.docs < MAX_DOCS_DIA) return true;
  if (!cuota.avisado) {
    cuota.avisado = true;
    logger.warn({ max: MAX_DOCS_DIA }, "Tope diario de logs alcanzado: se dejan de guardar hasta mañana (UTC)");
  }
  return false;
}

/** Escribe lo acumulado (1 doc por bloque). Devuelve una promesa (tests y apagado). */
function flushLogs() {
  if (escribiendo) return escribiendo;
  if (!buffer.length) return Promise.resolve();
  const ahora = new Date();
  if (ahora.getTime() < pausadoHasta || !hayCuota(ahora)) {
    descartados += buffer.length;
    buffer = [];
    return Promise.resolve();
  }
  const pendientes = buffer;
  buffer = [];
  escribiendo = (async () => {
    for (let i = 0; i < pendientes.length; i += POR_DOC) {
      const trozo = pendientes.slice(i, i + POR_DOC);
      if (Date.now() < pausadoHasta || !hayCuota(new Date())) {
        descartados += pendientes.length - i;
        break;
      }
      try {
        await db.collection(COLECCION).add(bloque(trozo));
        cuota.docs++;
      } catch (err) {
        descartados += pendientes.length - i;
        pausadoHasta = Date.now() + PAUSA_MS;
        logger.error({ err: err.message, code: err.code, pausaMs: PAUSA_MS }, "No se pudieron guardar los logs: escritura en pausa");
        break;
      }
    }
    if (descartados) {
      logger.warn({ descartados }, "Logs descartados (buffer lleno, tope diario, pausa o error)");
      descartados = 0;
    }
  })().finally(() => { escribiendo = null; });
  return escribiendo;
}

const temporizador = setInterval(() => { flushLogs(); }, FLUSH_MS);
temporizador.unref();

function accessLog(req, res, next) {
  if (!activo() || req.method === "OPTIONS" || EXCLUIDAS.has(req.path)) return next();
  const inicio = Date.now();
  res.on("finish", () => {
    const ts = new Date();
    const path = (req.originalUrl || req.url).split("?")[0];
    const ruta = req.route ? `${req.baseUrl || ""}${req.route.path}`.replace(/(.)\/$/, "$1") : null;
    actorDe(req)
      .then((actor) => encolar({
        ts,
        metodo: req.method,
        ruta,
        path: recorta(path, 200),
        modulo: moduloDe(path),
        status: res.statusCode,
        ms: ts.getTime() - inicio,
        uid: actor.uid,
        rol: actor.rol,
        anonimo: actor.anonimo,
        requestId: recorta(req.id, 64),
        queryKeys: Object.keys(req.query || {}).slice(0, 10).map((k) => k.slice(0, 40)),
        ipHash: hashIp(req.ip),
        userAgent: recorta(req.headers["user-agent"], 150),
        origen: recorta(req.headers.origin, 100),
      }))
      .catch((err) => logger.error({ err: err.message }, "accessLog"));
  });
  next();
}

/** Solo para tests. */
function _reset() {
  buffer = [];
  descartados = 0;
  pausadoHasta = 0;
  cuota = { dia: "", docs: 0 };
}

module.exports = { accessLog, flushLogs, _reset };
