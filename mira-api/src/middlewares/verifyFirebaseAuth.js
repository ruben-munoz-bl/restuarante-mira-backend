const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");
const { env } = require("../config/env");

if (!admin.apps.length) {
  const opts = { projectId: env.PROJECT_ID };
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.join(__dirname, "..", "..", "serviceAccountKey.json");
  if (fs.existsSync(keyPath)) {
    opts.credential = admin.credential.cert(require(keyPath));
  }
  admin.initializeApp(opts);
}

const db = admin.firestore();

async function resolveRole(uid) {
  try {
    const userDoc = await db.collection("usuarios").doc(uid).get();
    if (!userDoc.exists) return "cliente";
    const tipo = userDoc.data().tipo;
    if (tipo === "admin" || tipo === "empresa" || tipo === "cliente") return tipo;
    return "cliente";
  } catch {
    return "cliente";
  }
}

async function verifyFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_TOKEN", message: "Authorization header required" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const role = await resolveRole(decoded.uid);
    req.user = { uid: decoded.uid, email: decoded.email, role };
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
  admin.auth().verifyIdToken(idToken).then(async decoded => {
    const role = await resolveRole(decoded.uid);
    req.user = { uid: decoded.uid, email: decoded.email, role };
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
