const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function crearPromocion({ uid, restauranteId, tipo, fechaInicio, fechaFin, presupuestoTotal, cpc, puntosExtraPorReserva }) {
  const restSnap = await db.collection("restaurants").doc(restauranteId).get();
  if (!restSnap.exists) throw new Error("Restaurante no encontrado");
  const rest = restSnap.data();
  if (rest.ownerUid && rest.ownerUid !== uid) throw new Error("No eres dueño de este restaurante");

  const solapada = await db.collection("promociones")
    .where("restauranteId", "==", restauranteId)
    .where("estado", "==", "activa")
    .get();
  if (!solapada.empty) throw new Error("Ya hay una promoción activa para este restaurante");

  const docRef = await db.collection("promociones").add({
    restauranteId,
    tipo: tipo || "boost_visibilidad",
    estado: "activa",
    prioridad: 100,
    cpc: cpc || 0.20,
    presupuestoTotal,
    gastoAcumulado: 0,
    clicks: 0,
    views: 0,
    reservasGeneradas: 0,
    puntosExtraPorReserva: puntosExtraPorReserva || 0,
    fechaInicio: new Date(fechaInicio),
    fechaFin: new Date(fechaFin),
    createdAt: new Date(),
  });

  logger.info({ promoId: docRef.id, restauranteId }, "Promotion created");
  return { id: docRef.id };
}

async function getPromociones({ restauranteId, estado } = {}) {
  let query = db.collection("promociones");
  if (restauranteId) query = query.where("restauranteId", "==", restauranteId);
  if (estado) query = query.where("estado", "==", estado);
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

module.exports = { crearPromocion, getPromociones, getPromoActiva, registrarInteraccion, getPromoStats };
