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
const esFresco = (at) => Number(at) > 0 && Date.now() - Number(at) < CACHE_TTL_MS;
let inflight = null;
const stats = { cargas: 0, cargasCompletas: 0, aciertos: 0, misses: 0, desfasados: 0 };

// Marcado cuando se modifica un restaurante SIN cambiar el recuento de la
// colección (renombrar, cambiar teléfono...): el chequeo de frescura por
// número de documentos no lo detecta, así que hay que forzar la
// reconstrucción del documento _catalogo en la siguiente carga.
// Un arranque en frío no lo lleva: ahí sí se hidrata desde el documento.
let sucio = false;

/**
 * ¿El documento _catalogo recoge todos los restaurantes de la colección?
 * Compara `total` con el recuento real (count() = 1 lectura) para detectar
 * altas y bajas hechas fuera de este proceso (aprobaciones de negocios,
 * borrados desde el panel admin), que por sí solas no invalidan esta caché.
 */
async function catalogoDesactualizado(doc) {
  try {
    const snap = await db.collection("restaurants").count().get();
    const reales = snap.data().count - 1; // -1: el propio documento _catalogo
    if (Number(doc.total) === reales) return false;
    logger.info({ documentado: doc.total, reales }, "_catalogo desactualizado: se reconstruirá");
    return true;
  } catch (err) {
    // Si el recuento falla, mejor servir el documento que romper la búsqueda.
    logger.warn({ error: err.message }, "no se pudo comprobar la frescura de _catalogo");
    return false;
  }
}

async function catalogo() {
  const ahora = Date.now();
  if (cache.items && ahora - cache.at < CACHE_TTL_MS) {
    stats.aciertos += 1;
    return cache.items;
  }

  // Datos viejos pero utilizables: si estamos refrescando, se sirven igual.
  // Así una:ronda de peticiones simultáneas tras caducar la caché no se
  // convierte en 700 lecturas por cada una.
  if (cache.items && cache.refrescando) {
    stats.desfasados += 1;
    return cache.items;
  }

  if (inflight) {
    if (cache.items) {
      stats.desfasados += 1;
      return cache.items;
    }
    return inflight;
  }

  cache.refrescando = true;
  inflight = (async () => {
    stats.misses += 1;

    // PRIMERO: hidratar desde el documento _catalogo (1 lectura + 1 count).
    // Antes esto solo se usaba para el mapa, así que un arranque en frío
    // acababa leyendo los 700 restaurantes sueltos aunque el documento ya
    // existiera. Solo si se generó dentro del TTL (si no, un restaurante
    // recién aprobado no aparecería nunca), no está marcado como sucio y su
    // recuento sigue coincidiendo con la colección.
    const doc = await leerCatalogoMapa();
    const usable = doc && Array.isArray(doc.restaurantes) && doc.restaurantes.length;
    if (usable && esFresco(doc.generadoAt) && !sucio && !(await catalogoDesactualizado(doc))) {
      const items = doc.restaurantes.map((r) => ({ ...r, id: r.id || r._id }));
      cache = { at: Date.now(), items, byId: new Map(items.map((r) => [r.id, r])), refrescando: false, parcial: true };
      stats.cargas += 1;
      logger.info({ total: items.length, fuente: "_catalogo" }, "restaurants cache hidratada del documento");
      return items;
    }

    // Sin documento, caducado, desactualizado, sucio o invalidado: carga
    // completa (arranque en frío, TTL vencido, alta/baja fuera de este proceso,
    // o tras editar un restaurante).
    const snap = await db.collection("restaurants").get();
    // _catalogo es un documento técnico, no un restaurante.
    const items = snap.docs
      .filter((doc2) => doc2.id !== DOC_CATALOGO)
      .map((doc2) => mapearDoc(doc2.id, doc2.data()));
    const byId = new Map(items.map((r) => [r.id, r]));
    cache = { at: Date.now(), items, byId, refrescando: false, parcial: false };
    stats.cargas += 1;
    stats.cargasCompletas += 1;
    logger.info({ total: items.length, fuente: "firestore" }, "restaurants cache cargada");
    // Una escritura por recarga completa (como mucho una por TTL), no por
    // petición. Se regenera para que el próximo arranque en frío (o el de otra
    // instancia) vuelva a hidratar de él sin releer los 700 sueltos.
    try {
      const escrito = await regenerarCatalogoMapa(items);
      // `sucio` solo se limpia si el documento se reescribió de verdad: si no,
      // la siguiente carga repite el full scan en vez de servir copias viejas.
      if (escrito) sucio = false;
      else logger.warn({ items: items.length }, "no se regeneró el catálogo ligero: se repetirá la carga completa");
    } catch (err) {
      logger.warn({ error: err.message }, "no se pudo regenerar el catálogo ligero");
    }
    return items;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// ─── Catálogo ligero (documento único) ──────────────────────────────────────
// Leer los 698 restaurantes costs 698 lecturas cada vez que el servidor
// arranca en frío. Con un único documento generado guardamos el mismo catálogo
// con solo los campos del mapa: 1 lectura en vez de 698.
// Firestore reserva los ids que empiezan por "__": no puede usarse como nombre
// de documento. "_catalogo" sí es válido y no choca con un id real (Yelp/Firestore).
const DOC_CATALOGO = "_catalogo";
const MAX_BYTES_CATALOGO = 800 * 1024; // margen sobre el límite de 1 MiB de Firestore

// Lo que ve el frontend en /mapa: 8 campos, ~198 KB para 700 restaurantes.
const CAMPOS_MAPA = ["id", "nombre", "coordenadas", "rating_yelp", "precio", "categorias", "imagen_url", "ciudad"];

// Lo que se guarda en el documento _catalogo. Son los mismos + lo que el
// backend necesita para NO releer el restaurante suelto en cada búsqueda
// (filtro por zona/dirección y cálculo del aforo). Sin reseñas ni descripciones.
function versionInterna(r) {
  return {
    id: r.id,
    nombre: r.nombre,
    coordenadas: r.coordenadas || null,
    rating_yelp: typeof r.rating_yelp === "number" ? r.rating_yelp : null,
    total_resenas_yelp: typeof r.total_resenas_yelp === "number" ? r.total_resenas_yelp : null,
    precio: r.precio || null,
    categorias: Array.isArray(r.categorias) ? r.categorias.slice(0, 8) : [],
    imagen_url: r.imagen_url || null,
    ciudad: r.ciudad || null,
    zona_busqueda: r.zona_busqueda || null,
    direccion_completa: r.direccion_completa || r.direccion || null,
    telefono: r.telefono || null,
    uid: r.uid || null,
    email: r.email || null,
    activo: r.activo !== false,
    maxReservasPorHora: typeof r.maxReservasPorHora === "number" ? r.maxReservasPorHora : null,
  };
}

function versionMapa(r) {
  return {
    id: r.id,
    nombre: r.nombre,
    coordenadas: r.coordenadas || null,
    rating_yelp: typeof r.rating_yelp === "number" ? r.rating_yelp : null,
    precio: r.precio || null,
    categorias: Array.isArray(r.categorias) ? r.categorias.slice(0, 6) : [],
    imagen_url: r.imagen_url || null,
    ciudad: r.ciudad || null,
  };
}

/** Devuelve el catálogo ligero guardado, o null si aún no se ha generado. */
async function leerCatalogoMapa() {
  try {
    const snap = await db.collection("restaurants").doc(DOC_CATALOGO).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (!Array.isArray(data.restaurantes) || data.restaurantes.length === 0) return null;
    return data;
  } catch (err) {
    logger.warn({ error: err.message }, "no se pudo leer el catálogo ligero");
    return null;
  }
}

/**
 * Regenera el documento del catálogo ligero a partir de los datos ya cargados.
 * Devuelve true si se escribió. No hace nada si el catálogo no existe o
 * exceedería el tamaño seguro.
 */
async function regenerarCatalogoMapa(items) {
  if (!items || !items.length) return false;
  const restaurantes = items.map(versionInterna);
  const doc = {
    _tipo: "catalogo",
    version: CAMPOS_MAPA,
    generadoAt: Date.now(),
    total: restaurantes.length,
    restaurantes,
  };
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  } catch {
    return false;
  }
  if (bytes > MAX_BYTES_CATALOGO) {
    logger.warn({ bytes, max: MAX_BYTES_CATALOGO }, "catálogo ligero demasiado grande: no se regenera");
    return false;
  }
  await db.collection("restaurants").doc(DOC_CATALOGO).set(doc);
  logger.info({ total: restaurantes.length, bytes }, "catálogo ligero regenerado");
  return true;
}

/**
 * Versión ligera del catálogo para el mapa. Sale de catalogo(), que respeta el
 * TTL: memoria (0 lecturas) → documento _catalogo reciente (1 lectura) →
 * restaurantes sueltos, regenerando el documento.
 */
async function listarMapa({ ciudad = null } = {}) {
  const items = (await catalogo()).map(versionMapa);
  return ciudad ? items.filter((r) => r.ciudad === ciudad) : items;
}

/** Solo para tests: vacía la memoria como un arranque en frío, sin tocar el documento. */
function vaciarMemoriaCatalogo() {
  cache = { at: 0, items: null, byId: null };
}

function invalidarCatalogo() {
  cache = { at: 0, items: null, byId: null };
  // El documento lo comparten todas las instancias y los arranques en frío: si
  // no se marca como caducado, seguirían sirviendo la versión vieja.
  db.collection("restaurants").doc(DOC_CATALOGO).set({ generadoAt: 0 }, { merge: true }).catch((err) =>
    logger.warn({ error: err.message }, "no se pudo invalidar el catálogo ligero"),
  );
}

/**
 * Invalida la caché tras modificar un restaurante y marca el documento
 * _catalogo como obsoleto: un cambio de nombre no altera el recuento de la
 * colección, así que sin este marcador la siguiente carga hidrataría la copia
 * vieja del documento y el buscador seguiría mostrando el nombre anterior.
 */
function invalidarCatalogoPorEscritura() {
  sucio = true;
  invalidarCatalogo();
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
    let docs = snap.docs.filter((doc) => doc.id !== DOC_CATALOGO);
    let items = docs.map((doc) => mapearDoc(doc.id, doc.data()));
    const last = docs.length ? docs[docs.length - 1] : null;
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
  // Si la caché está hidratada desde _catalogo (parcial), la ficha no trae
  // reseñas ni campos pesados: hay que leer el documento real (1 lectura) para
  // devolver el detalle completo que espera el frontend.
  if (cache.byId && cache.byId.has(id)) {
    const cached = cache.byId.get(id);
    if (!cache.parcial) {
      stats.aciertos += 1;
      return cached;
    }
    const doc = await db.collection("restaurants").doc(id).get();
    if (doc.exists) {
      const item = mapearDoc(doc.id, doc.data());
      cache.byId.set(id, item);
      stats.aciertos += 1;
      return item;
    }
    return cached;
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
  invalidarCatalogoPorEscritura();
  logger.info({ restaurantId, uid }, "Restaurant updated");
  return { updated: true };
}

module.exports = {
  listarRestaurantes,
  listarMapa,
  contarRestaurantes,
  obtenerRestaurante,
  obtenerPorUid,
  obtenerPorEmail,
  actualizarRestaurante,
  invalidarCatalogo,
  invalidarCatalogo,
  invalidarCatalogoPorEscritura,
  vaciarMemoriaCatalogo,
  regenerarCatalogoMapa,
  estadisticasCache,
  DOC_CATALOGO,
  TAMANO_PAGINA,
};
