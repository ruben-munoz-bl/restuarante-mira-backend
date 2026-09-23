const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { PUNTOS_PROMO_VIEW, PUNTOS_PROMO_CLICK } = require("../../config/constants");
const { addPuntos } = require("../points/service");
const { getPromoActiva, registrarInteraccion } = require("../promotions/service");

async function registrarVista(uid, restauranteId) {
  const promo = await getPromoActiva(restauranteId);
  if (!promo) return { sinPromo: true };

  const existeVista = await db.collection("puntos_movimientos")
    .where("uid", "==", uid)
    .where("tipo", "==", "promo_view")
    .limit(1)
    .get();
  if (!existeVista.empty) return { yaVisto: true, puntos: 0 };

  await registrarInteraccion(promo.id, "view");
  const result = await addPuntos(uid, PUNTOS_PROMO_VIEW, "promo_view", "Vista de promoción");

  return { puntos: PUNTOS_PROMO_VIEW, nuevoSaldo: result.nuevoSaldo };
}

async function registrarClick(uid, restauranteId) {
  const promo = await getPromoActiva(restauranteId);
  if (!promo) return { sinPromo: true };

  await registrarInteraccion(promo.id, "click");
  const result = await addPuntos(uid, PUNTOS_PROMO_CLICK, "promo_click", "Clic en promoción");

  return { puntos: PUNTOS_PROMO_CLICK, nuevoSaldo: result.nuevoSaldo };
}

module.exports = { registrarVista, registrarClick };
