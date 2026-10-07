/**
 * Trazabilidad: un registro en `logs` por cada petición a la API,
 * con o sin sesión iniciada.
 *
 * Organización (colección plana `logs/{autoId}`, un doc por petición):
 * - Plana y con autoId: escrituras repartidas (sin hotspots) y consultas
 *   directas por uid, ruta, módulo o día sin collectionGroup.
 * - `ruta` es el patrón de Express (/v1/reservations/:id) para agrupar;
 *   `path` es la URL real para seguir un caso concreto.
 * - Campos planos (uid, rol, anonimo) para poder filtrarlos con índices simples.
 * - `expiraEn` para una política TTL de Firestore (borrado automático).
 * - No se guardan bodies, tokens ni valores de query; la IP va con hash.
 *
 * Para no cargar la BD: los registros se acumulan en memoria y se escriben
 * en lotes (batch) cada LOGS_FLUSH_MS o al llegar a LOGS_BATCH. Nunca bloquea
 * ni rompe la respuesta: si Firestore falla, se registra en pino y se sigue.
 */
const crypto = require("crypto");
const { db, admin } = require("./verifyFirebaseAuth");
const { logger } = require("./errorHandler");

const COLECCION = "logs";
const FLUSH_MS = Number(process.env.LOGS_FLUSH_MS) || 5000;
const LOTE = Math.min(Number(process.env.LOGS_BATCH) || 400, 500); // límite de Firestore: 500
const MAX_BUFFER = Number(process.env.LOGS_MAX_BUFFER) || 5000;
const TTL_DIAS = Number(process.env.LOGS_TTL_DIAS) || 90;
const SAL_IP = process.env.LOGS_IP_SALT || "mira-logs";
const EXCLUIDAS = new Set(["/health"]);

let buffer = [];
let descartados = 0;
let escribiendo = null;

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
  if (buffer.length >= LOTE) flushLogs();
}

/** Escribe lo acumulado en lotes. Devuelve una promesa (útil en tests y al apagar). */
function flushLogs() {
  if (escribiendo) return escribiendo.then(() => (buffer.length ? flushLogs() : undefined));
  if (!buffer.length) return Promise.resolve();
  const pendientes = buffer;
  buffer = [];
  escribiendo = (async () => {
    for (let i = 0; i < pendientes.length; i += LOTE) {
      const trozo = pendientes.slice(i, i + LOTE);
      try {
        const batch = db.batch();
        const col = db.collection(COLECCION);
        trozo.forEach((r) => batch.set(col.doc(), r));
        await batch.commit();
      } catch (err) {
        descartados += trozo.length;
        logger.error({ err: err.message, perdidos: trozo.length }, "No se pudieron guardar los logs");
      }
    }
    if (descartados) {
      logger.warn({ descartados }, "Logs descartados (buffer lleno o error de escritura)");
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
    const ruta = req.route ? `${req.baseUrl || ""}${req.route.path}` : path;
    actorDe(req)
      .then((actor) => encolar({
        ts,
        dia: ts.toISOString().slice(0, 10),
        metodo: req.method,
        ruta,
        path: path.slice(0, 300),
        modulo: moduloDe(path),
        status: res.statusCode,
        ok: res.statusCode < 400,
        ms: Date.now() - inicio,
        uid: actor.uid,
        rol: actor.rol,
        anonimo: actor.anonimo,
        requestId: req.id || null,
        queryKeys: Object.keys(req.query || {}).slice(0, 20),
        ipHash: hashIp(req.ip),
        userAgent: String(req.headers["user-agent"] || "").slice(0, 200) || null,
        origen: req.headers.origin || null,
        expiraEn: new Date(ts.getTime() + TTL_DIAS * 86400000),
      }))
      .catch((err) => logger.error({ err: err.message }, "accessLog"));
  });
  next();
}

function _pendientes() {
  return buffer.length;
}

module.exports = { accessLog, flushLogs, _pendientes };
