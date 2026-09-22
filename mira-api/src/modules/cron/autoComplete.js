const { db } = require("../../middlewares/verifyFirebaseAuth");
const { completarReserva } = require("../reservations/service");
const { logger } = require("../../middlewares/errorHandler");
const { env } = require("../../config/env");

async function autoCompletarReservas() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - env.AUTO_COMPLETE_HOURS * 60 * 60 * 1000);
  const hoy = now.toISOString().split("T")[0];

  const snapshot = await db.collection("reservas")
    .where("estado", "==", "confirmada")
    .where("fecha", "==", hoy)
    .get();

  let completadas = 0;
  for (const doc of snapshot.docs) {
    const reserva = doc.data();
    const [hora, minuto] = reserva.hora.split(":").map(Number);
    const fechaHoraReserva = new Date(`${reserva.fecha}T${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}:00`);

    if (fechaHoraReserva <= cutoff) {
      try {
        await completarReserva(doc.id, { emitidoPor: "sistema" });
        completadas++;
      } catch (err) {
        logger.error({ reservaId: doc.id, error: err.message }, "Auto-complete failed");
      }
    }
  }

  logger.info({ completadas, total: snapshot.size }, "Auto-complete reservations check done");
}

module.exports = { autoCompletarReservas };
