const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { env } = require("../../config/env");

const TAMANO_PAGINA = 27;

// ─── Caché de catálogo ──────────────────────────────────────────────────────
// El catálogo se leía entero en cada búsqueda de texto, listado y contador
// (~690 lecturas por petición). Se carga una vez y se sirve en memoria con TTL,
// invalidándolo cuando se escribe. Evita que un buscador del frontend (o el
// agente) agote la cuota gratuita de Firestore.
const CACHE_TTL_MS = Number(env.CATALOG_CACHE_TTL_MS) || 5 * 60 * 1000;

let cache = { at: 0, items: null, byId: null };
let inflight = null;
const stats = { cargas: 0, aciertos: 0, misses: 0 };

async function catalogo() {
  const ahora = Date.now();
  if (cache.items && ahora - cache.at < CACHE_TTL_MS) {
    stats.aciertos += 1;
    return cache.items;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    stats.misses += 1;
    const snap = await db.collection("restaurants").get();
    const items = snap.docs.map((doc) => mapearDoc(doc.id, doc.data()));
    const byId = new Map(items.map((r) => [r.id, r]));
    cache = { at: Date.now(), items, byId };
    stats.cargas += 1;
    logger.info({ total: items.length }, "restaurants cache cargada");
    return items;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function invalidarCatalogo() {
  cache = { at: 0, items: null, byId: null };
}

function estadisticasCache() {
  return {
    ...stats,
    ttlMs: CACHE_TTL_MS,
    cargadoEnMsAgo: cache.items ? Date.now() - cache.at : null,
    tamano: cache.items ? cache.items.length : 0,
  };
}

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
    let items = await catalogo();
    items = sortRatingDesc(items);
    if (ciudad) items = items.filter((r) => r.ciudad === ciudad);
    if (zona) items = items.filter((r) => r.zona_busqueda === zona);
    if (cocina) items = items.filter((r) => (r.categorias || []).includes(cocina));
    if (q) items = filtrarPorTexto(items, q);
    return { items, cursor: null, terminado: true };
  }

  // Búsqueda sin all=1: filtra sobre el catálogo cacheado (0 lecturas en Firestore).
  if (hayFiltroTexto) {
    let items = await catalogo();
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
    // Fallback: pagina sobre el catálogo cacheado (misma semántica, 0 lecturas).
    logger.warn({ error: e.message }, "restaurants: falta índice, usando caché en memoria");
    let items = await catalogo();
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
  // El total sale del catálogo cacheado: 0 lecturas en Firestore.
  const items = await catalogo();
  return items.length;
}

async function obtenerRestaurante(id) {
  // Primero caché (0 lecturas); si no está, una sola lectura al doc.
  if (cache.byId && cache.byId.has(id)) {
    stats.aciertos += 1;
    return cache.byId.get(id);
  }
  const doc = await db.collection("restaurants").doc(id).get();
  if (!doc.exists) {
    const err = new Error("Restaurante no encontrado");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const item = mapearDoc(doc.id, doc.data());
  if (cache.byId) cache.byId.set(id, item);
  return item;
}

async function obtenerPorUid(uid) {
  const items = await catalogo();
  return items.filter((r) => r.uid === uid);
}

async function obtenerPorEmail(email) {
  const items = await catalogo();
  return items.filter((r) => r.email === email);
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
  invalidarCatalogo();
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
  invalidarCatalogo,
  estadisticasCache,
  TAMANO_PAGINA,
};
