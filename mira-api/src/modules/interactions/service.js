const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { PUNTOS_PROMO_VIEW, PUNTOS_PROMO_CLICK } = require("../../config/constants");
const { addMovement } = require("../points/service");
const { getPromoActiva, registrarInteraccion } = require("../promotions/service");

async function registrarVista(uid, restauranteId) {
  const promo = await getPromoActiva(restauranteId);
  if (!promo) return { sinPromo: true };

  const existeVista = await db.collection("movimientos")
    .where("uid", "==", uid)
    .where("tipo", "==", "promo_view")
    .where("referenciaId", "==", restauranteId)
    .limit(1)
    .get();
  if (!existeVista.empty) return { yaVisto: true, puntos: 0 };

  await registrarInteraccion(promo.id, "view");
  const result = await addMovement(uid, "promo_view", PUNTOS_PROMO_VIEW, {
    referenciaTipo: "promocion",
    referenciaId: promo.id,
  });

  return { puntos: PUNTOS_PROMO_VIEW, nuevoSaldo: result.nuevoSaldo };
}

async function registrarClick(uid, restauranteId) {
  const promo = await getPromoActiva(restauranteId);
  if (!promo) return { sinPromo: true };

  await registrarInteraccion(promo.id, "click");
  const result = await addMovement(uid, "promo_click", PUNTOS_PROMO_CLICK, {
    referenciaTipo: "promocion",
    referenciaId: promo.id,
  });

  return { puntos: PUNTOS_PROMO_CLICK, nuevoSaldo: result.nuevoSaldo };
}

module.exports = { registrarVista, registrarClick };
