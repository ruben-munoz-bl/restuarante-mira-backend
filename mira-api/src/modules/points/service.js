const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function addMovement(uid, tipo, cantidad, opts = {}) {
  const { referenciaTipo, referenciaId, ip } = opts;
  if (!uid || !tipo || typeof cantidad !== "number" || cantidad === 0) {
    throw new Error("Invalid movement params");
  }

  const result = await db.runTransaction(async (tx) => {
    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const userData = userSnap.data();

    const saldoActual = userData.saldoPuntos || 0;
    const nuevoSaldo = saldoActual + cantidad;
    if (nuevoSaldo < 0) throw new Error("Saldo insuficiente");

    tx.update(userRef, {
      saldoPuntos: nuevoSaldo,
      totalAcumulado: (userData.totalAcumulado || 0) + Math.max(0, cantidad),
      totalCanjeado: (userData.totalCanjeado || 0) + Math.abs(Math.min(0, cantidad)),
      updatedAt: new Date(),
    });

    const movRef = db.collection("movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo,
      cantidad,
      saldoResultante: nuevoSaldo,
      referenciaTipo: referenciaTipo || null,
      referenciaId: referenciaId || null,
      createdAt: new Date(),
    });

    return { nuevoSaldo, movId: movRef.id };
  });

  logger.info({ uid, tipo, cantidad, nuevoSaldo: result.nuevoSaldo }, "Movement recorded");
  return result;
}

async function getBalance(uid) {
  const userDoc = await db.collection("usuarios").doc(uid).get();
  if (!userDoc.exists) throw new Error("Usuario no encontrado");
  const data = userDoc.data();
  return {
    saldoActual: data.saldoPuntos || 0,
    totalAcumulado: data.totalAcumulado || 0,
    totalCanjeado: data.totalCanjeado || 0,
    rachaLogin: data.rachaLogin || { dias: 0, ultimoLogin: null, graceUsados: 0 },
    rachaReservas: data.rachaReservas || { semanasConsecutivas: 0, multiplicador: 1 },
  };
}

async function getLedger(uid, { tipo, page = 1, limit = 20 } = {}) {
  let query = db.collection("movimientos").where("uid", "==", uid).orderBy("createdAt", "desc");
  if (tipo) query = query.where("tipo", "==", tipo);
  const snapshot = await query.limit(limit).get();
  const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { data, total: data.length, page, limit };
}

async function redeemPoints(uid, puntos) {
  if (puntos <= 0 || puntos % 100 !== 0) throw new Error("Puntos deben ser múltiplo de 100 y positivos");

  const result = await db.runTransaction(async (tx) => {
    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const userData = userSnap.data();
    const saldo = userData.saldoPuntos || 0;
    if (saldo < puntos) throw new Error("Saldo insuficiente");

    const descuento = Math.round(puntos * 0.01 * 100) / 100;

    tx.update(userRef, {
      saldoPuntos: saldo - puntos,
      totalCanjeado: (userData.totalCanjeado || 0) + puntos,
      updatedAt: new Date(),
    });

    const movRef = db.collection("movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo: "canje_descuento",
      cantidad: -puntos,
      saldoResultante: saldo - puntos,
      referenciaTipo: "redeem",
      referenciaId: null,
      descuentoAplicado: descuento,
      createdAt: new Date(),
    });

    return { nuevoSaldo: saldo - puntos, descuento };
  });

  logger.info({ uid, puntos, descuento: result.descuento }, "Points redeemed");
  return result;
}

module.exports = { addMovement, getBalance, getLedger, redeemPoints };
