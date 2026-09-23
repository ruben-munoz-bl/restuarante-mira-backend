const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const PRECIOS = ["€", "€€", "€€€"];

function validarPropuesta(d) {
  if (!d.nombre?.trim()) throw new Error("El nombre es obligatorio.");
  if (!d.ciudad?.trim()) throw new Error("La ciudad es obligatoria.");
  if (!d.zona) throw new Error("Elige la zona.");
  if (!d.direccion?.trim()) throw new Error("La dirección es obligatoria.");
  if (!PRECIOS.includes(d.precio)) throw new Error("Precio no válido.");
  if (!Array.isArray(d.categorias) || !d.categorias.length) {
    throw new Error("Indica al menos una cocina (separadas por comas).");
  }
}

async function proponerNegocio({ uid, email, datos }) {
  if (!uid) throw new Error("Debes iniciar sesión para proponer tu local.");
  validarPropuesta(datos);

  const docRef = await db.collection("negocios").add({
    uid,
    email: email || "",
    estado: "pendiente",
    nombre: datos.nombre.trim(),
    ciudad: datos.ciudad.trim(),
    zona: datos.zona,
    direccion: datos.direccion.trim(),
    telefono: (datos.telefono || "").trim(),
    categorias: datos.categorias,
    precio: datos.precio,
    descripcion: (datos.descripcion || "").trim(),
    imagen_url: (datos.imagen_url || "").trim(),
    accesoDiscapacidad: datos.accesoDiscapacidad ?? null,
    menuInfantil: datos.menuInfantil ?? null,
    entornoTranquilo: datos.entornoTranquilo ?? null,
    tronas: datos.tronas ?? null,
    terraza: datos.terraza ?? null,
    alergenos: (datos.alergenos || "").trim(),
    creado: new Date(),
  });

  logger.info({ uid, negocioId: docRef.id }, "Negocio propuesto");
  return { id: docRef.id };
}

async function listarMisNegocios(uid) {
  const snap = await db.collection("negocios").where("uid", "==", uid).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.creado?.seconds ?? 0) - (a.creado?.seconds ?? 0));
  return list;
}

async function listarNegociosPendientes() {
  const snap = await db.collection("negocios").where("estado", "==", "pendiente").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function aprobarNegocio(negocioId) {
  const ref = db.collection("negocios").doc(negocioId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("La propuesta ya no existe.");
  const n = snap.data();
  if (n.estado === "aprobada") throw new Error("Ya estaba aprobada.");

  const restRef = db.collection("restaurants").doc();
  const userRef = db.collection("usuarios").doc(n.uid);
  const userSnap = await userRef.get().catch(() => null);
  const userData = userSnap && userSnap.exists() ? userSnap.data() : {};

  const restaurantIds = Array.isArray(userData.restaurantIds) ? [...userData.restaurantIds] : [];
  if (userData.restaurantId && !restaurantIds.includes(userData.restaurantId)) {
    restaurantIds.push(userData.restaurantId);
  }
  if (!restaurantIds.includes(restRef.id)) {
    restaurantIds.push(restRef.id);
  }

  const userUpdate = { tipo: "empresa", restaurantIds };
  if (!userData.restaurantId) userUpdate.restaurantId = restRef.id;

  await db.runTransaction(async (tx) => {
    tx.set(restRef, {
      nombre: n.nombre,
      categorias: n.categorias,
      precio: n.precio,
      ciudad: n.ciudad,
      zona_busqueda: n.zona,
      direccion_completa: n.direccion,
      telefono: n.telefono || "",
      descripcion: n.descripcion || "",
      imagen_url: n.imagen_url || "",
      rating_yelp: null,
      total_resenas_yelp: 0,
      accesoDiscapacidad: n.accesoDiscapacidad ?? null,
      menuInfantil: n.menuInfantil ?? null,
      entornoTranquilo: n.entornoTranquilo ?? null,
      tronas: n.tronas ?? null,
      terraza: n.terraza ?? null,
      alergenos: n.alergenos || "",
      resenas: [],
      uid: n.uid,
      email: n.email || "",
      activo: true,
      comisionPct: Number(require("../../config/env").env.COMISION_PCT) || 8,
      creado: new Date(),
    });
    tx.update(userRef, userUpdate);
    tx.update(ref, { estado: "aprobada", restaurantId: restRef.id });
  });

  logger.info({ uid: n.uid, restaurantId: restRef.id }, "Negocio aprobado");
  return restRef.id;
}

async function rechazarNegocio(negocioId) {
  await db.collection("negocios").doc(negocioId).update({ estado: "rechazada" });
}

module.exports = {
  proponerNegocio,
  listarMisNegocios,
  listarNegociosPendientes,
  aprobarNegocio,
  rechazarNegocio,
};
