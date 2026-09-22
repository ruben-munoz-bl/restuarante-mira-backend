const admin = require("firebase-admin");
const { env } = require("../config/env");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: env.PROJECT_ID });
}

const db = admin.firestore();

async function verifyFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_TOKEN", message: "Authorization header required" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid, email: decoded.email, role: decoded.role || "cliente" };
    next();
  } catch (err) {
    return res.status(401).json({ error: "INVALID_TOKEN", message: "Token inválido o expirado" });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }
  const idToken = authHeader.split("Bearer ")[1];
  admin.auth().verifyIdToken(idToken).then(decoded => {
    req.user = { uid: decoded.uid, email: decoded.email, role: decoded.role || "cliente" };
    next();
  }).catch(() => {
    req.user = null;
    next();
  });
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "FORBIDDEN", message: "No tienes permiso" });
    next();
  };
}

module.exports = { verifyFirebaseAuth, optionalAuth, authorize, db, admin };
