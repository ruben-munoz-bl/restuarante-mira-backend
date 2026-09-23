const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function getRevenue({ from, to } = {}) {
  let query = db.collection("tickets");
  if (from) query = query.where("createdAt", ">=", new Date(from));
  if (to) query = query.where("createdAt", "<=", new Date(to));

  const snapshot = await query.orderBy("createdAt", "desc").limit(500).get();
  let total = 0;
  let comisiones = 0;
  const porRestaurante = {};

  for (const doc of snapshot.docs) {
    const ticket = doc.data();
    total += ticket.totalPagado || 0;
    const comision = ticket.importeComision || 0;
    comisiones += comision;
    const restId = ticket.restaurantId;
    if (!porRestaurante[restId]) {
      porRestaurante[restId] = { comision: 0, tickets: 0, nombre: ticket.restauranteNombre || ticket.nombreRestaurante };
    }
    porRestaurante[restId].comision += comision;
    porRestaurante[restId].tickets++;
  }

  return {
    total: Math.round(total * 100) / 100,
    comisiones: Math.round(comisiones * 100) / 100,
    tickets: snapshot.size,
    totalComision: Math.round(comisiones * 100) / 100,
    porRestaurante,
  };
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
