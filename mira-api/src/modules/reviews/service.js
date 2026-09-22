const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { PUNTOS_REVIEW } = require("../../config/constants");
const { addMovement } = require("../points/service");

async function crearReview(uid, { restauranteId, puntuacion, comentario }) {
  if (!comentario || comentario.length < 20) throw new Error("Comentario debe tener al menos 20 caracteres");
  if (puntuacion < 1 || puntuacion > 5) throw new Error("Puntuación: 1-5");

  const reservaSnap = await db.collection("reservas")
    .where("uid", "==", uid)
    .where("restaurantId", "==", restauranteId)
    .where("estado", "==", "completada")
    .limit(1)
    .get();
  if (reservaSnap.empty) throw new Error("Debes haber asistido al restaurante para reseñar");

  const existingReview = await db.collection("resenas")
    .where("uid", "==", uid)
    .where("restauranteId", "==", restauranteId)
    .limit(1)
    .get();
  if (!existingReview.empty) throw new Error("Ya reseñaste este restaurante");

  const docRef = await db.collection("resenas").add({
    uid,
    restauranteId,
    puntuacion,
    comentario,
    likes: 0,
    likedBy: [],
    createdAt: new Date(),
  });

  const result = await addMovement(uid, "resena", PUNTOS_REVIEW, {
    referenciaTipo: "resena",
    referenciaId: docRef.id,
  });

  logger.info({ uid, restauranteId, reviewId: docRef.id }, "Review created");
  return { reviewId: docRef.id, puntos: PUNTOS_REVIEW, nuevoSaldo: result.nuevoSaldo };
}

async function getReviewsByRestaurant(restauranteId) {
  const snap = await db.collection("resenas").where("restauranteId", "==", restauranteId).orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { crearReview, getReviewsByRestaurant };
