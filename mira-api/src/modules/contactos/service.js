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

async function resolverIncidencia(id, resolucion, resolverUid) {
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
  if (!resolverUid) {
    const err = new Error("Se requiere el administrador que resuelve");
    err.status = 400;
    throw err;
  }
  const ref = db.collection("contactos").doc(id);
  const adminSnap = await db.collection("usuarios").doc(resolverUid).get();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error("Incidencia no encontrada"); err.status = 404; throw err;
    }
    if (snap.data().estado === "resuelta") {
      const err = new Error("La incidencia ya está resuelta"); err.status = 409; throw err;
    }
    const actualizacion = { ...datos, estado: "resuelta", resueltoPor: resolverUid,
      resueltoPorNombre: adminSnap.data()?.nombre || resolverUid, resueltaEn: new Date() };
    tx.update(ref, actualizacion);
    return { ...snap.data(), ...actualizacion, id, ok: true };
  });
}

async function listarResueltas() {
  const snap = await db.collection("contactos").where("estado", "==", "resuelta").get();
  const fecha = (v) => v?.toDate ? v.toDate().getTime() : new Date(v).getTime() || 0;
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => fecha(b.resueltaEn) - fecha(a.resueltaEn));
}

module.exports = { crearContacto, listarMisIncidencias, listarPendientes, listarResueltas, resolverIncidencia };
