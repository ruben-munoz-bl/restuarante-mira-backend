const { db } = require("./verifyFirebaseAuth");
const { logger } = require("./errorHandler");

const rateLimitStore = new Map();
// La ventana caduca: si nadie vuelve a tocar una clave, sus timestamps se
// pueden tirar. Sin esta purga cada IP nueva dejaba una entrada para siempre
// y el Map crecia sin limite (la instancia de Render tiene solo 512 MB).
const MAX_CLAVES = 20000;
const MAX_VENTANA_MS = 300000;
const SWEEP_MS = 5 * 60 * 1000;

function purgar() {
  const ahora = Date.now();
  for (const [key, hits] of rateLimitStore) {
    const vivos = hits.filter((t) => t > ahora - MAX_VENTANA_MS);
    if (vivos.length === 0) rateLimitStore.delete(key);
    else if (vivos.length !== hits.length) rateLimitStore.set(key, vivos);
  }
  if (rateLimitStore.size > MAX_CLAVES) {
    const sobra = rateLimitStore.size - MAX_CLAVES;
    let i = 0;
    for (const key of rateLimitStore.keys()) {
      if (i++ >= sobra) break;
      rateLimitStore.delete(key);
    }
    logger.warn({ eliminadas: sobra, quedan: rateLimitStore.size }, "rateLimit: Map recortado por tamaño");
  }
}

const temporizadorPurgar = setInterval(() => {
  try {
    purgar();
  } catch (err) {
    logger.warn({ error: err.message }, "rateLimit: fallo al purgar");
  }
}, SWEEP_MS);
temporizadorPurgar.unref();

function rateLimitKey(req) {
  const route = `${req.baseUrl || ""}${req.path}`;
  return `${req.user?.uid || req.ip}:${route}`;
}

function clearRateLimits() {
  rateLimitStore.clear();
}

function rateLimit(windowMs = 60000, max = 100) {
  return (req, res, next) => {
    const key = rateLimitKey(req);
    const now = Date.now();
    const windowStart = now - windowMs;
    if (rateLimitStore.size > MAX_CLAVES && !rateLimitStore.has(key)) purgar();
    if (!rateLimitStore.has(key)) rateLimitStore.set(key, []);
    const hits = rateLimitStore.get(key).filter(t => t > windowStart);
    hits.push(now);
    rateLimitStore.set(key, hits);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - hits.length));
    if (hits.length > max) {
      logger.warn({ key, hits: hits.length }, "Rate limit exceeded");
      return res.status(429).json({ error: "RATE_LIMITED", message: "Demasiadas peticiones, intenta más tarde" });
    }
    next();
  };
}

// Firestore no admite `undefined` (ni NaN/Infinity). El body cacheado puede
// traerlos, así que se limpian antes de guardar para no romper la respuesta.
function firestoreSafe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(firestoreSafe);
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = firestoreSafe(v);
    }
    return out;
  }
  return value;
}

async function idempotency(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key) return next();
  const uid = req.user?.uid || "anonymous";
  const docId = `${uid}_${key}`;
  try {
    const doc = await db.collection("idempotencyKeys").doc(docId).get();
    if (doc.exists) {
      const cached = doc.data();
      // Nunca re-servimos un error cacheado: solo successes (2xx).
      if (cached.status >= 200 && cached.status < 300) {
        return res.status(cached.status).json(cached.body);
      }
      await db.collection("idempotencyKeys").doc(docId).delete().catch(() => {});
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      // Cachear es un extra: si falla, la respuesta al cliente debe salir igual.
      // Ojo: set() puede lanzar de forma SINCRONA al validar, por eso try/catch.
      if (status >= 200 && status < 300) {
        try {
          db.collection("idempotencyKeys")
            .doc(docId)
            .set({ status, body: firestoreSafe(body), createdAt: new Date() })
            .catch((err) => logger.warn({ docId, error: err.message }, "idempotency cache failed"));
        } catch (err) {
          logger.warn({ docId, error: err.message }, "idempotency cache failed");
        }
      }
      return originalJson(body);
    };
    next();
  } catch (err) {
    logger.warn({ docId, error: err.message }, "idempotency lookup failed");
    next();
  }
}

module.exports = { rateLimit, idempotency, clearRateLimits };
