const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

function semanaISO(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return `${d.getFullYear()}-W${String(1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)).padStart(2, "0")}`;
}

async function actualizarRachasReservas() {
  const semanaActual = semanaISO(new Date());
  const semanaAnterior = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return semanaISO(d);
  })();

  const usuariosSnap = await db.collection("usuarios").get();
  const batch = db.batch();
  let count = 0;

  for (const doc of usuariosSnap.docs) {
    const uid = doc.id;
    const user = doc.data();

    const reservaSnap = await db.collection("reservas")
      .where("uid", "==", uid)
      .where("estado", "==", "completada")
      .where("fecha", ">=", getInicioSemana(semanaAnterior))
      .where("fecha", "<=", getFinSemana(semanaAnterior))
      .limit(1)
      .get();

    if (!reservaSnap.empty) {
      batch.update(db.collection("usuarios").doc(uid), {
        rachaReservasSemanas: (user.rachaReservasSemanas || user.rachaReservas?.semanasConsecutivas || 0) + 1,
        rachaReservasMultiplicador: 1.2,
        rachaReservasUltimaSemana: semanaAnterior,
      });
    } else {
      batch.update(db.collection("usuarios").doc(uid), {
        rachaReservasSemanas: 0,
        rachaReservasMultiplicador: 1,
        rachaReservasUltimaSemana: semanaAnterior,
      });
    }

    count++;
    if (count % 500 === 0) {
      await batch.commit();
    }
  }

  if (count % 500 !== 0) await batch.commit();
  logger.info({ count }, "Rachas de reservas actualizadas");
}

function getInicioSemana(semanaStr) {
  const [year, week] = semanaStr.split("-W").map(Number);
  const jan4 = new Date(year, 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const target = new Date(startOfWeek1);
  target.setDate(startOfWeek1.getDate() + (week - 1) * 7);
  return target.toISOString().split("T")[0];
}

function getFinSemana(semanaStr) {
  const inicio = getInicioSemana(semanaStr);
  const d = new Date(inicio + "T00:00:00Z");
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}

module.exports = { actualizarRachasReservas };
