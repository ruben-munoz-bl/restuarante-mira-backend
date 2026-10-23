const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const { comprobarRestaurante } = require("../../middlewares/ownership");
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const millis = v => v?.toMillis ? v.toMillis() : new Date(v).getTime();
// Las campañas futuras también reservan la plaza; solo se ignoran las caducadas.
const vigente = p => p.estado === "activa" && !(millis(p.fechaFin) < Date.now());

async function crearPromocion({ uid, user, restauranteId, tipo, fechaInicio, fechaFin, presupuestoTotal, cpc, puntosExtraPorReserva }) {
  await comprobarRestaurante(restauranteId, user || { uid, role: "empresa" });
  const restRef = db.collection("restaurants").doc(restauranteId);
  const docRef = db.collection("promociones").doc();
  await db.runTransaction(async tx => {
    const rest = await tx.get(restRef);
    if (!rest.exists) throw error(404, "NOT_FOUND", "Restaurante no encontrado");
    const anteriores = await tx.get(db.collection("promociones").where("restauranteId", "==", restauranteId).where("estado", "==", "activa"));
    if (anteriores.docs.some(d => vigente(d.data()))) throw error(409, "CONFLICT", "Ya hay una promoción activa para este restaurante");
    // Documento compartido por altas y ediciones: serializa también altas simultáneas.
    tx.update(restRef, { promocionesVersion: (rest.data().promocionesVersion || 0) + 1 });
    tx.set(docRef, { restauranteId, tipo: tipo || "boost_visibilidad", estado: "activa", prioridad: 100,
      cpc: cpc || 0.20, presupuestoTotal, gastoAcumulado: 0, clicks: 0, views: 0, reservasGeneradas: 0,
      puntosExtraPorReserva: puntosExtraPorReserva || 0, fechaInicio: new Date(fechaInicio), fechaFin: new Date(fechaFin), createdAt: new Date() });
  });
  logger.info({ promoId: docRef.id, restauranteId }, "Promotion created");
  return { id: docRef.id };
}

async function editarPromocion(id, cambios, user) {
  const ref = db.collection("promociones").doc(id);
  const previa = await ref.get();
  if (!previa.exists) throw error(404, "NOT_FOUND", "Promoción no encontrada");
  const restauranteId = previa.data().restauranteId;
  await comprobarRestaurante(restauranteId, user);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw error(404, "NOT_FOUND", "Promoción no encontrada");
    const actual = snap.data();
    if (actual.restauranteId !== restauranteId) throw error(403, "FORBIDDEN", "La promoción cambió de restaurante");
    const restRef = db.collection("restaurants").doc(restauranteId);
    const rest = await tx.get(restRef);
    if (!rest.exists) throw error(404, "NOT_FOUND", "Restaurante no encontrado");
    const update = { ...cambios, updatedAt: new Date() };
    if (cambios.fechaFin !== undefined) update.fechaFin = new Date(cambios.fechaFin);
    const nueva = { ...actual, ...update };
    if (millis(nueva.fechaFin) < millis(actual.fechaInicio)) throw error(400, "VALIDATION_ERROR", "La fecha final no puede preceder a la inicial");
    if (nueva.presupuestoTotal < (actual.gastoAcumulado || 0)) throw error(400, "VALIDATION_ERROR", "El presupuesto no puede ser inferior al gasto acumulado");
    if (vigente(nueva)) {
      const otras = await tx.get(db.collection("promociones").where("restauranteId", "==", restauranteId).where("estado", "==", "activa"));
      if (otras.docs.some(d => d.id !== id && vigente(d.data()))) throw error(409, "CONFLICT", "Ya hay otra promoción activa");
    }
    tx.update(restRef, { promocionesVersion: (rest.data().promocionesVersion || 0) + 1 });
    tx.update(ref, update);
    return { id, restauranteId, fechaFin: new Date(millis(nueva.fechaFin)).toISOString(), presupuestoTotal: nueva.presupuestoTotal, estado: nueva.estado };
  });
}

async function getPromociones({ restauranteId, estado, autenticado = false } = {}) {
  let query = db.collection("promociones");
  if (restauranteId) query = query.where("restauranteId", "==", restauranteId);
  if (estado) query = query.where("estado", "==", estado);
  const snap = await query.get();
  return snap.docs.map((d) => {
    const promo = { id: d.id, ...d.data() };
    // Sin sesión se ocultan presupuesto y gasto: son datos del restaurante.
    if (!autenticado) {
      delete promo.presupuestoTotal;
      delete promo.gastoAcumulado;
    }
    return promo;
  });
}

async function getPromoActiva(restauranteId) {
  const snap = await db.collection("promociones")
    .where("restauranteId", "==", restauranteId)
    .where("estado", "==", "activa")
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function registrarInteraccion(promoId, tipo) {
  const promoRef = db.collection("promociones").doc(promoId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(promoRef);
    if (!snap.exists) return;
    const promo = snap.data();
    const update = {};
    if (tipo === "click") {
      update.clicks = (promo.clicks || 0) + 1;
      update.gastoAcumulado = Math.round((promo.gastoAcumulado || 0) + (promo.cpc || 0.20) * 100) / 100;
    } else {
      update.views = (promo.views || 0) + 1;
    }
    if ((update.gastoAcumulado || 0) >= (promo.presupuestoTotal || Infinity)) {
      update.estado = "finalizada";
    }
    tx.update(promoRef, update);
  });
}

async function getPromoStats(promoId) {
  const doc = await db.collection("promociones").doc(promoId).get();
  if (!doc.exists) throw new Error("Promoción no encontrada");
  const p = doc.data();
  const ctr = p.views > 0 ? Math.round((p.clicks / p.views) * 100 * 100) / 100 : 0;
  return { views: p.views, clicks: p.clicks, ctr, reservasGeneradas: p.reservasGeneradas, gastoAcumulado: p.gastoAcumulado };
}

module.exports = { editarPromocion, crearPromocion, getPromociones, getPromoActiva, registrarInteraccion, getPromoStats };
