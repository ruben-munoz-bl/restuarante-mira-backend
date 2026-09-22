const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function getRevenue({ from, to } = {}) {
  let query = db.collection("tickets").where("estado", "in", ["emitido", "pagado"]);
  if (from) query = query.where("createdAt", ">=", new Date(from));
  if (to) query = query.where("createdAt", "<=", new Date(to));

  const snapshot = await query.get();
  let totalComision = 0;
  const porRestaurante = {};

  for (const doc of snapshot.docs) {
    const ticket = doc.data();
    const comision = ticket.importeComision || 0;
    totalComision += comision;
    const restId = ticket.restaurantId;
    if (!porRestaurante[restId]) {
      porRestaurante[restId] = { comision: 0, tickets: 0, nombre: ticket.nombreRestaurante };
    }
    porRestaurante[restId].comision += comision;
    porRestaurante[restId].tickets++;
  }

  return { totalComision: Math.round(totalComision * 100) / 100, porRestaurante };
}

async function getFraudFlags() {
  const snap = await db.collection("fraudFlags").orderBy("createdAt", "desc").limit(100).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function crearFraudFlag({ uid, tipo, detalle }) {
  await db.collection("fraudFlags").add({
    uid,
    tipo,
    detalle: detalle || {},
    estado: "abierto",
    createdAt: new Date(),
  });
}

async function resolverFraudFlag(flagId, { resolverUid, accion }) {
  await db.collection("fraudFlags").doc(flagId).update({
    estado: accion,
    resueltoPor: resolverUid,
    resueltoEn: new Date(),
  });
}

module.exports = { getRevenue, getFraudFlags, crearFraudFlag, resolverFraudFlag };
