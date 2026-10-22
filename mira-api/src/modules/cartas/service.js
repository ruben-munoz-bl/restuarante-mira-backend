const { randomUUID } = require("crypto");
const { db } = require("../../middlewares/verifyFirebaseAuth");
const error = () => Object.assign(new Error("Restaurante o carta no encontrados"), { status: 404, code: "NOT_FOUND" });

async function obtener(restauranteId, editar = false) {
  const rest = await db.collection("restaurants").doc(restauranteId).get();
  if (!rest.exists) throw error();
  const snap = await db.collection("cartas").doc(restauranteId).get();
  if (!snap.exists) {
    if (editar) return { restauranteId, categorias: [], actualizada: null };
    throw error();
  }
  const carta = snap.data();
  return { restauranteId, categorias: editar ? carta.categorias : carta.categorias
    .map(c => ({ ...c, platos: c.platos.filter(p => p.disponible === true) })).filter(c => c.platos.length),
  actualizada: carta.actualizada };
}

async function guardar(restauranteId, data) {
  // Reservar primero los IDs aportados para que los generados nunca colisionen.
  const usados = new Set(data.categorias.flatMap(c => [c.id, ...c.platos.map(p => p.id)]).filter(Boolean));
  const nuevoId = prefijo => {
    let id;
    do { id = prefijo + randomUUID(); } while (usados.has(id));
    usados.add(id); return id;
  };
  const carta = { restauranteId, categorias: data.categorias.map(c => ({ ...c, id: c.id || nuevoId("cat_"),
    platos: c.platos.map(p => ({ ...p, id: p.id || nuevoId("pl_"), foto: p.foto ?? null })),
  })), actualizada: new Date().toISOString() };
  await db.runTransaction(async tx => {
    const rest = await tx.get(db.collection("restaurants").doc(restauranteId));
    if (!rest.exists) throw error();
    tx.set(db.collection("cartas").doc(restauranteId), carta);
  });
  return carta;
}
module.exports = { obtener, guardar };
