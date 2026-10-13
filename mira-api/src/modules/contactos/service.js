const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function crearContacto({ uid, nombre, email, motivo, mensaje }) {
  const docRef = await db.collection("contactos").add({
    uid: uid || null,
    nombre: String(nombre || "").trim(),
    email: String(email || "").trim(),
    motivo,
    mensaje: String(mensaje || "").trim(),
    estado: "pendiente",
    creado: new Date(),
  });
  logger.info({ uid, contactoId: docRef.id }, "Contact message created");
  return { id: docRef.id };
}

async function listarMisIncidencias(uid) {
  if (!uid) return [];
  const snap = await db.collection("contactos").where("uid", "==", uid).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.creado?.seconds ?? 0) - (a.creado?.seconds ?? 0));
  return list;
}

async function listarPendientes() {
  const snap = await db.collection("contactos").where("estado", "==", "pendiente").get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (a.creado?.seconds ?? 0) - (b.creado?.seconds ?? 0));
  return list;
}

async function resolverIncidencia(id, resolucion) {
  const datos = {};
  for (const campo of ["propuestaResolucion", "solucion", "encargado"]) {
    const valor = String(resolucion?.[campo] || "").trim();
    if (!valor) {
      const err = new Error("La resolución requiere propuesta, solución y encargado");
      err.status = 400;
      throw err;
    }
    datos[campo] = valor;
  }
  await db.collection("contactos").doc(id).update({ ...datos, estado: "resuelta" });
  return { ok: true };
}

module.exports = { crearContacto, listarMisIncidencias, listarPendientes, resolverIncidencia };
