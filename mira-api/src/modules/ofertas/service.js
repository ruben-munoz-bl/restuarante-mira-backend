/**
 * Ofertas por distancia en Firestore (colección `ofertas`). Una sola activa por
 * restaurante; la oferta no guarda nada del usuario ni de su ubicación.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { vigente } = require("./logica");

const col = () => db.collection("ofertas");

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function vista(doc) {
  const d = doc.data();
  return {
    id: doc.id, restauranteId: d.restauranteId, titulo: d.titulo, activa: d.activa,
    desde: d.desde ?? null, hasta: d.hasta ?? null, niveles: d.niveles, creado: d.creado, actualizado: d.actualizado,
  };
}

async function delRestaurante(restauranteId) {
  const snap = await col().where("restauranteId", "==", String(restauranteId)).get();
  // Orden en memoria: un restaurante tiene pocas ofertas y así no hace falta índice compuesto.
  return snap.docs.map(vista).sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
}

/** Pública: solo la oferta activa y vigente hoy. */
async function publicas(restauranteId) {
  return (await delRestaurante(restauranteId)).filter((o) => vigente(o));
}

async function comprobarUnicaActiva(restauranteId, exceptoId = null) {
  const activas = (await delRestaurante(restauranteId)).filter((o) => o.activa && o.id !== exceptoId);
  if (activas.length) throw error(409, "CONFLICT", "Ya hay otra oferta activa en este restaurante");
}

function campos(d) {
  return { titulo: d.titulo, activa: d.activa, desde: d.desde ?? null, hasta: d.hasta ?? null, niveles: d.niveles };
}

async function crear(datos) {
  if (datos.activa) await comprobarUnicaActiva(datos.restauranteId);
  const ahora = new Date().toISOString();
  const { id } = await col().add({ restauranteId: String(datos.restauranteId), ...campos(datos), creado: ahora, actualizado: ahora });
  return obtener(id);
}

async function obtener(id) {
  const snap = await col().doc(String(id)).get();
  if (!snap.exists) throw error(404, "NOT_FOUND", "Oferta no encontrada");
  return vista(snap);
}

async function editar(id, datos) {
  const actual = await obtener(id);
  if (datos.activa) await comprobarUnicaActiva(actual.restauranteId, actual.id);
  await col().doc(actual.id).update({ ...campos(datos), actualizado: new Date().toISOString() });
  return obtener(actual.id);
}

async function borrar(id) {
  await col().doc(String(id)).delete();
}

module.exports = { publicas, delRestaurante, crear, obtener, editar, borrar };
