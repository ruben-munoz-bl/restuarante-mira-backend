const { db } = require("./verifyFirebaseAuth");
const { logger } = require("./errorHandler");

const rateLimitStore = new Map();

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
