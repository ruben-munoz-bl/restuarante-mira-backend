const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const PERFIL_KEYS = ["tipo", "nombre", "email", "soloVegano", "alergias", "lang", "consentimientoCookies", "preferencias", "accesibilidad", "favoritos"];

async function getMe(uid) {
  const snap = await db.collection("usuarios").doc(uid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return {
    uid,
    tipo: d.tipo === "empresa" || d.tipo === "admin" ? d.tipo : "cliente",
    nombre: d.nombre || "",
    email: d.email || "",
    soloVegano: d.soloVegano === true,
    alergias: Array.isArray(d.alergias) ? d.alergias : [],
    lang: d.lang || "",
    consentimientoCookies: d.consentimientoCookies || null,
    preferencias: d.preferencias || null,
    accesibilidad: d.accesibilidad || null,
    favoritos: Array.isArray(d.favoritos) ? d.favoritos : [],
    restaurantId: d.restaurantId || null,
    restaurantIds: Array.isArray(d.restaurantIds) ? d.restaurantIds : [],
    saldoPuntos: d.saldoPuntos || 0,
    createdAt: d.createdAt || null,
    actualizado: d.actualizado || null,
  };
}

async function updateMe(uid, datos) {
  const update = {};
  PERFIL_KEYS.forEach((k) => {
    if (datos[k] !== undefined) update[k] = datos[k];
  });
  if (Object.keys(update).length === 0) return { updated: false };
  update.actualizado = new Date();
  await db.collection("usuarios").doc(uid).set(update, { merge: true });
  logger.info({ uid, fields: Object.keys(update) }, "User profile updated");
  return { updated: true };
}

async function esAdmin(uid) {
  if (!uid) return false;
  try {
    const snap = await db.collection("usuarios").doc(uid).get();
    return snap.exists && snap.data().tipo === "admin";
  } catch {
    return false;
  }
}

async function getAllUsers() {
  const { calcRachaLogin } = require("../points/service");
  const snap = await db.collection("usuarios").get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    const racha = calcRachaLogin(d);
    return {
      uid: doc.id,
      nombre: d.nombre,
      email: d.email,
      tipo: d.tipo,
      saldoPuntos: d.saldoPuntos || 0,
      rachaLoginDias: Math.min(d.rachaLoginDias || 0, 7),
      ultimoLoginDate: d.ultimoLoginDate || null,
      yaReclamadoHoy: Boolean(racha.yaReclamado),
      createdAt: d.createdAt,
    };
  });
}

module.exports = { getMe, updateMe, esAdmin, getAllUsers };
