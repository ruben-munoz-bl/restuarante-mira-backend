const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { PUNTOS_LOGIN_BASE, PUNTOS_LOGIN_INCREMENTO, PUNTOS_LOGIN_CAP, PUNTOS_LOGIN_GRACE_MAX } = require("../../config/constants");

function hoyStr() {
  return new Date().toISOString().split("T")[0];
}

function esAyer(fechaStr) {
  const hoy = new Date();
  hoy.setDate(hoy.getDate() - 1);
  return hoy.toISOString().split("T")[0] === fechaStr;
}

async function reclamarLoginDiario(uid) {
  const result = await db.runTransaction(async (tx) => {
    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const user = userSnap.data();
    const racha = user.rachaLogin || { dias: 0, ultimoLogin: null, graceUsados: 0 };
    const hoy = hoyStr();

    if (racha.ultimoLogin === hoy) {
      return { yaReclamado: true, puntos: 0, racha };
    }

    let dias;
    if (racha.ultimoLogin === null) {
      dias = 1;
    } else if (hoy === sumarDias(racha.ultimoLogin, 1)) {
      dias = (racha.dias || 0) + 1;
    } else if (esAyer(racha.ultimoLogin) || hoy === racha.ultimoLogin) {
      dias = (racha.dias || 0) + 1;
    } else {
      const graceUsados = racha.graceUsados || 0;
      if (graceUsados < PUNTOS_LOGIN_GRACE_MAX) {
        dias = (racha.dias || 0) + 1;
        tx.update(userRef, { "rachaLogin.graceUsados": graceUsados + 1 });
      } else {
        dias = 1;
        tx.update(userRef, { "rachaLogin.graceUsados": 0 });
      }
    }

    const puntos = Math.min(PUNTOS_LOGIN_BASE + PUNTOS_LOGIN_INCREMENTO * Math.max(0, dias - 1), PUNTOS_LOGIN_CAP);
    const nuevoSaldo = (user.saldoPuntos || 0) + puntos;

    tx.update(userRef, {
      saldoPuntos: nuevoSaldo,
      totalAcumulado: (user.totalAcumulado || 0) + puntos,
      rachaLogin: { dias, ultimoLogin: hoy, graceUsados: racha.graceUsados || 0 },
      updatedAt: new Date(),
    });

    const movRef = db.collection("movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo: "login_diario",
      cantidad: puntos,
      saldoResultante: nuevoSaldo,
      referenciaTipo: "login",
      referenciaId: hoy,
      createdAt: new Date(),
    });

    return { yaReclamado: false, puntos, racha: { dias, ultimoLogin: hoy, graceUsados: racha.graceUsados || 0 } };
  });

  logger.info({ uid, puntos: result.puntos }, "Daily login claimed");
  return result;
}

function sumarDias(fechaStr, n) {
  const d = new Date(fechaStr + "T00:00:00Z");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

module.exports = { reclamarLoginDiario };
