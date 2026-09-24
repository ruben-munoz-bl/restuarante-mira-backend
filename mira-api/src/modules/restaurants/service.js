const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const TAMANO_PAGINA = 27;

function mapearDoc(id, data) {
  return { id, ...data };
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const json = Buffer.from(String(cursor), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.rating === "number" && parsed.id) return parsed;
  } catch { /* ignore */ }
  return null;
}

function encodeCursor(rating, id) {
  return Buffer.from(JSON.stringify({ rating, id }), "utf8").toString("base64");
}

function isIndexError(err) {
  const msg = String(err?.message || err?.code || "");
  return err?.code === "failed-precondition" || msg.includes("index") || msg.includes("FAILED_PRECONDITION");
}

function sortRatingDesc(items) {
  return items.sort((a, b) => (b.rating_yelp || 0) - (a.rating_yelp || 0) || String(a.id).localeCompare(String(b.id)));
}

function applyCursors(items, decoded) {
  if (!decoded) return items;
  const idx = items.findIndex(
    (r) => String(r.id) === String(decoded.id) && Number(r.rating_yelp || 0) === Number(decoded.rating),
  );
  return idx >= 0 ? items.slice(idx + 1) : items;
}

async function listarRestaurantes({ limit = TAMANO_PAGINA, all = false, cursor = null, ratingYelp = null, ciudad = null, zona = null, cocina = null, q = null } = {}) {
  const decoded = decodeCursor(cursor);
  const pageSize = Math.max(1, Math.min(Number(limit) || TAMANO_PAGINA, 100));
  const hayFiltroTexto = q != null && String(q).trim() !== "";

  if (all || Number(limit) === 0) {
    const snap = await db.collection("restaurants").get();
    let items = snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
    items = sortRatingDesc(items);
    if (ciudad) items = items.filter((r) => r.ciudad === ciudad);
    if (zona) items = items.filter((r) => r.zona_busqueda === zona);
    if (cocina) items = items.filter((r) => (r.categorias || []).includes(cocina));
    if (q) items = filtrarPorTexto(items, q);
    return { items, cursor: null, terminado: true };
  }

  // Búsqueda sin all=1: filtra en todo el catálogo y pagina en memoria (q no se limita a una página).
  if (hayFiltroTexto) {
    const snap = await db.collection("restaurants").get();
    let items = snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
    items = sortRatingDesc(items);
    if (ciudad) items = items.filter((r) => r.ciudad === ciudad);
    if (zona) items = items.filter((r) => r.zona_busqueda === zona);
    if (cocina) items = items.filter((r) => (r.categorias || []).includes(cocina));
    items = filtrarPorTexto(items, q);
    items = applyCursors(items, decoded);
    const page = items.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      items: page,
      cursor: last ? encodeCursor(last.rating_yelp ?? 0, last.id) : null,
      terminado: page.length < pageSize,
    };
  }

  // __name__ desc = desempate coherente con el índice single-field de rating_yelp DESC.
  // Sin esta 2ª orderBy, startAfter(rating, id) falla con "Too many cursor values".
  let query = db
    .collection("restaurants")
    .orderBy("rating_yelp", "desc")
    .orderBy("__name__", "desc");
  if (ciudad) query = query.where("ciudad", "==", ciudad);
  if (zona) query = query.where("zona_busqueda", "==", zona);
  if (cocina) query = query.where("categorias", "array-contains", cocina);
  if (decoded) query = query.startAfter(decoded.rating, decoded.id);
  query = query.limit(pageSize);

  try {
    const snap = await query.get();
    let items = snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
    const last = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
    return {
      items,
      cursor: last ? encodeCursor(last.data().rating_yelp ?? 0, last.id) : null,
      terminado: snap.docs.length < pageSize,
    };
  } catch (e) {
    if (!isIndexError(e)) throw e;
    // Fallback: carga total, ordena en memoria y pagina con el cursor (misma semántica).
    const snap = await db.collection("restaurants").get();
    let items = snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
    items = sortRatingDesc(items);
    if (ciudad) items = items.filter((r) => r.ciudad === ciudad);
    if (zona) items = items.filter((r) => r.zona_busqueda === zona);
    if (cocina) items = items.filter((r) => (r.categorias || []).includes(cocina));
    if (q) items = filtrarPorTexto(items, q);
    items = applyCursors(items, decoded);
    const page = items.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      items: page,
      cursor: last ? encodeCursor(last.rating_yelp ?? 0, last.id) : null,
      terminado: page.length < pageSize,
    };
  }
}

function normalizar(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function filtrarPorTexto(items, q) {
  const needle = normalizar(q).trim();
  if (!needle) return items;
  return items.filter((r) => {
    const hay = normalizar(
      [r.nombre, ...(r.categorias || []), r.ciudad, r.zona_busqueda, r.direccion_completa || r.direccion].join(" "),
    );
    return hay.includes(needle);
  });
}

async function contarRestaurantes() {
  const snap = await db.collection("restaurants").count().get();
  return snap.data().count;
}

async function obtenerRestaurante(id) {
  const doc = await db.collection("restaurants").doc(id).get();
  if (!doc.exists) {
    const err = new Error("Restaurante no encontrado");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  return mapearDoc(doc.id, doc.data());
}

async function obtenerPorUid(uid) {
  const snap = await db.collection("restaurants").where("uid", "==", uid).get();
  return snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
}

async function obtenerPorEmail(email) {
  const snap = await db.collection("restaurants").where("email", "==", email).get();
  return snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
}

async function actualizarRestaurante(restaurantId, uid, data) {
  const allowed = [
    "nombre",
    "direccion",
    "telefono",
    "email",
    "horarios",
    "activo",
    "ciudad",
    "zona",
    "precio",
    "cocina",
    "descripcion",
    "comisionPct",
    "maxReservasPorHora",
  ];

  const update = {};
  allowed.forEach((k) => {
    if (data[k] !== undefined) update[k] = data[k];
  });
  if (Object.keys(update).length === 0) return { updated: false };
  update.updatedAt = new Date();

  await db.collection("restaurants").doc(restaurantId).update(update);
  logger.info({ restaurantId, uid }, "Restaurant updated");
  return { updated: true };
}

module.exports = {
  listarRestaurantes,
  contarRestaurantes,
  obtenerRestaurante,
  obtenerPorUid,
  obtenerPorEmail,
  actualizarRestaurante,
  TAMANO_PAGINA,
};
