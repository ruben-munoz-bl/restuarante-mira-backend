const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function estadisticasPromociones() {
  const snapshot = await db.collection("promociones").where("estado", "==", "activa").get();
  let count = 0;

  for (const doc of snapshot.docs) {
    const promo = doc.data();
    if (promo.gastoAcumulado >= (promo.presupuestoTotal || Infinity)) {
      await db.collection("promociones").doc(doc.id).update({ estado: "finalizada" });
      count++;
    }
  }

  logger.info({ finalizadas: count }, "Promotion stats check done");
}

module.exports = { estadisticasPromociones };
