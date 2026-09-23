const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function crearResena({ restauranteId, uid, usuarioNombre, puntuacion, comentario }) {
  if (!puntuacion || puntuacion < 1 || puntuacion > 5) throw new Error("Puntuación 1-5.");
  if (!comentario || !String(comentario).trim()) throw new Error("Escribe un comentario.");

  const docRef = await db.collection("resenas").add({
    restauranteId: String(restauranteId),
    usuarioId: uid,
    usuarioNombre: usuarioNombre || "",
    puntuacion: Number(puntuacion),
    comentario: String(comentario).trim(),
    likes: 0,
    likedBy: [],
    createdAt: new Date(),
  });

  logger.info({ uid, restauranteId, reviewId: docRef.id }, "Review created");
  return docRef.id;
}

async function listarResenasDeRestaurante(restauranteId) {
  const snap = await db.collection("resenas").where("restauranteId", "==", String(restauranteId)).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || (b.puntuacion || 0) - (a.puntuacion || 0));
  return list;
}

async function listarResenasDeUsuario(usuarioId) {
  const snap = await db.collection("resenas").where("usuarioId", "==", usuarioId).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return list;
}

async function darLike(resenaId, usuarioId) {
  const ref = db.collection("resenas").doc(resenaId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Reseña no encontrada");
    const data = snap.data();
    const likedBy = Array.isArray(data.likedBy) ? data.likedBy : [];
    if (likedBy.includes(usuarioId)) return;
    tx.update(ref, {
      likes: (data.likes || 0) + 1,
      likedBy: [...likedBy, usuarioId],
    });
  });
}

async function quitarLike(resenaId, usuarioId) {
  const ref = db.collection("resenas").doc(resenaId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Reseña no encontrada");
    const data = snap.data();
    const likedBy = Array.isArray(data.likedBy) ? data.likedBy : [];
    if (!likedBy.includes(usuarioId)) return;
    tx.update(ref, {
      likes: Math.max(0, (data.likes || 0) - 1),
      likedBy: likedBy.filter((u) => u !== usuarioId),
    });
  });
}

module.exports = { crearResena, listarResenasDeRestaurante, listarResenasDeUsuario, darLike, quitarLike };
