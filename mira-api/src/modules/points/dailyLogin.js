const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { calcRachaLogin, hoyStr } = require("./service");

async function reclamarLoginDiario(uid) {
  const userRef = db.collection("usuarios").doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("Usuario no encontrado");
    const d = userSnap.data();
    const racha = calcRachaLogin(d);

    if (racha.yaReclamado) {
      return { yaReclamado: true, puntos: 0, racha };
    }

    if (racha.dia7Disponible) {
      tx.update(userRef, {
        rachaLoginDias: racha.dias,
        ultimoLoginDate: racha.ultimoLogin,
        graceUsados: racha.graceUsados,
        updatedAt: new Date(),
      });
      return {
        yaReclamado: false,
        puntos: 0,
        racha,
        dia7Disponible: true,
        nuevoSaldo: d.saldoPuntos || 0,
      };
    }

    const puntos = racha.puntos;
    const nuevoSaldo = (d.saldoPuntos || 0) + puntos;
    tx.update(userRef, {
      saldoPuntos: nuevoSaldo,
      totalAcumulado: (d.totalAcumulado || 0) + puntos,
      rachaLoginDias: racha.dias,
      ultimoLoginDate: racha.ultimoLogin,
      graceUsados: racha.graceUsados,
      updatedAt: new Date(),
    });
    const movRef = db.collection("puntos_movimientos").doc();
    tx.set(movRef, {
      uid,
      tipo: "login_diario",
      puntos,
      descripcion: `Login diario día ${racha.dias}`,
      createdAt: new Date(),
    });

    return { yaReclamado: false, puntos, racha, nuevoSaldo };
  });

  logger.info({ uid, puntos: result.puntos }, "Daily login claimed");
  return result;
}

module.exports = { reclamarLoginDiario };
