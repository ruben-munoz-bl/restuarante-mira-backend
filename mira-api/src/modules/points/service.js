const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const WHEEL_PRIZES = [
  { puntos: 20, label: "20 MIRA", peso: 475 },
  { puntos: 25, label: "25 MIRA", peso: 200 },
  { puntos: 30, label: "30 MIRA", peso: 150 },
  { puntos: 50, label: "50 MIRA", peso: 120 },
  { puntos: 100, label: "100 MIRA", peso: 5 },
];

function hoyStr() {
  // Día local del usuario (Península), no UTC: evita desfases 00:00–02:00.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
}

function calcRachaLogin(data) {
  const hoy = hoyStr();
  const ultimo = data.ultimoLoginDate || null;
  if (ultimo === hoy) {
    return {
      dias: Math.min(data.rachaLoginDias || 0, 7),
      ultimoLogin: ultimo,
      graceUsados: data.graceUsados || 0,
      yaReclamado: true,
      puntos: 0,
      dia7Disponible: (data.rachaLoginDias || 0) >= 7,
    };
  }
  const anterior = new Date(ultimo || hoy);
  const diff = Math.floor((new Date(hoy) - anterior) / 86400000);
  let dias = Math.min(data.rachaLoginDias || 0, 7);
  let grace = data.graceUsados || 0;
  if (diff === 1) {
    dias += 1;
  } else if (diff === 2 && grace < 2) {
    grace += 1;
  } else {
    dias = diff > 2 ? 1 : (dias || 0) + 1;
    if (diff > 2) grace = 0;
  }
  dias = Math.min(dias, 7);
  const dia7Disponible = dias >= 7;
  const pts = dia7Disponible ? 0 : Math.min(5 + 3 * Math.max(0, dias - 1), 15);
  return { dias, ultimoLogin: hoy, graceUsados: grace, puntos: pts, yaReclamado: false, dia7Disponible };
}

async function getBalance(uid) {
  const userDoc = await db.collection("usuarios").doc(uid).get();
  const d = userDoc.exists ? userDoc.data() : {};
  const proy = calcRachaLogin(d);
  const diasAlmacenados = Math.min(d.rachaLoginDias || 0, 7);
  return {
    saldoActual: d.saldoPuntos || 0,
    totalAcumulado: d.totalAcumulado || 0,
    totalCanjeado: d.totalCanjeado || 0,
    rachaLogin: {
      // Estado REAL de Firestore (no la proyección de "si reclamaras ahora").
      dias: diasAlmacenados,
      ultimoLogin: d.ultimoLoginDate || null,
      graceUsados: d.graceUsados || 0,
      yaReclamado: Boolean(proy.yaReclamado),
      // Puntos que daría el reclamo de hoy (0 si ya reclamado o día 7).
      puntosHoy: proy.yaReclamado ? 0 : (proy.puntos ?? 0),
      dia7Disponible: Boolean(proy.dia7Disponible),
      diasTrasReclamo: proy.dias,
    },
    rachaReservas: {
      semanasConsecutivas: d.rachaReservasSemanas || 0,
      multiplicador: d.rachaReservasMultiplicador || 1,
    },
  };
}

async function isNewUser(uid) {
  const userDoc = await db.collection("usuarios").doc(uid).get();
  const d = userDoc.exists ? userDoc.data() : {};
  return !d.ultimoLoginDate && (d.rachaLoginDias || 0) === 0;
}

async function getLedger(uid, { tipo, limit = 20 } = {}) {
  let query = db.collection("puntos_movimientos").where("uid", "==", uid).orderBy("createdAt", "desc");
  if (tipo) query = query.where("tipo", "==", tipo);
  const snapshot = await query.limit(Number(limit) || 20).get();
  const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { data };
}

async function addPuntos(uid, cantidad, tipo, descripcion) {
  const userRef = db.collection("usuarios").doc(uid);
  const movRef = db.collection("puntos_movimientos").doc();
  const nuevoSaldo = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const data = userSnap.data();
    const saldo = (data.saldoPuntos || 0) + cantidad;
    if (saldo < 0) throw new Error("Saldo insuficiente");
    tx.update(userRef, {
      saldoPuntos: saldo,
      totalAcumulado: (data.totalAcumulado || 0) + Math.max(0, cantidad),
      totalCanjeado: (data.totalCanjeado || 0) + Math.abs(Math.min(0, cantidad)),
      updatedAt: new Date(),
    });
    tx.set(movRef, {
      uid,
      tipo,
      puntos: cantidad,
      descripcion: descripcion || "",
      createdAt: new Date(),
    });
    return saldo;
  });
  return { nuevoSaldo };
}

async function redeem(uid, puntos) {
  if (puntos <= 0) throw new Error("Puntos deben ser positivos");
  const result = await db.runTransaction(async (tx) => {
    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const data = userSnap.data();
    if ((data.saldoPuntos || 0) < puntos) throw new Error("Saldo insuficiente");
    const saldo = (data.saldoPuntos || 0) - puntos;
    tx.update(userRef, {
      saldoPuntos: saldo,
      totalCanjeado: (data.totalCanjeado || 0) + puntos,
      updatedAt: new Date(),
    });
    const movRef = db.collection("puntos_movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo: "canje_descuento",
      puntos: -puntos,
      descripcion: `Canje de ${puntos} puntos`,
      createdAt: new Date(),
    });
    return { nuevoSaldo: saldo };
  });
  logger.info({ uid, puntos }, "Points redeemed");
  return result;
}

function spinWheel() {
  const totalPeso = WHEEL_PRIZES.reduce((s, p) => s + p.peso, 0);
  let rand = Math.random() * totalPeso;
  for (const prize of WHEEL_PRIZES) {
    rand -= prize.peso;
    if (rand <= 0) return prize;
  }
  return WHEEL_PRIZES[0];
}

function getWheelPrizes() {
  return WHEEL_PRIZES.map((p) => ({ puntos: p.puntos, label: p.label }));
}

async function claimWheelReward(uid, { force = false } = {}) {
  const userRef = db.collection("usuarios").doc(uid);
  const prize = spinWheel();
  const nuevoSaldo = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const data = userSnap.data();
    const dias = data.rachaLoginDias || 0;
    // Cada 7 días se gira la ruleta (salvo force en test/dev).
    if (!force && dias < 7) {
      const err = new Error(`Ruleta no disponible: racha ${dias}/7`);
      err.status = 403;
      err.code = "WHEEL_LOCKED";
      throw err;
    }
    const saldo = (data.saldoPuntos || 0) + prize.puntos;
    tx.update(userRef, {
      saldoPuntos: saldo,
      totalAcumulado: (data.totalAcumulado || 0) + prize.puntos,
      rachaLoginDias: 0,
      ultimoLoginDate: hoyStr(),
      graceUsados: 0,
      updatedAt: new Date(),
    });
    const movRef = db.collection("puntos_movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo: "ruleta_dia7",
      puntos: prize.puntos,
      descripcion: `Ruleta día 7: ${prize.label}`,
      createdAt: new Date(),
    });
    return saldo;
  });
  logger.info({ uid, puntos: prize.puntos }, "Wheel reward claimed");
  return { puntos: prize.puntos, label: prize.label, nuevoSaldo };
}

async function reviewPoints(uid) {
  const { nuevoSaldo } = await addPuntos(uid, 20, "resena", "Reseña reseña");
  return { puntos: 20, nuevoSaldo };
}

module.exports = {
  calcRachaLogin,
  getBalance,
  isNewUser,
  getLedger,
  addPuntos,
  redeem,
  getWheelPrizes,
  claimWheelReward,
  reviewPoints,
  hoyStr,
};
