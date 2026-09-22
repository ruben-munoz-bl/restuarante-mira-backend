const { db } = require("./verifyFirebaseAuth");
const { logger } = require("./errorHandler");

const rateLimitStore = new Map();

function rateLimit(windowMs = 60000, max = 100) {
  return (req, res, next) => {
    const key = `${req.user?.uid || req.ip}_${req.path}`;
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

async function idempotency(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key) return next();
  const uid = req.user?.uid || "anonymous";
  const docId = `${uid}_${key}`;
  try {
    const doc = await db.collection("idempotencyKeys").doc(docId).get();
    if (doc.exists) {
      const cached = doc.data();
      return res.status(cached.status).json(cached.body);
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      db.collection("idempotencyKeys").doc(docId).set({ status: res.statusCode, body, createdAt: new Date() });
      return originalJson(body);
    };
    next();
  } catch {
    next();
  }
}

module.exports = { rateLimit, idempotency };
