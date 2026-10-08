/**
 * Foto de Google Places de un restaurante, servida al vuelo.
 *
 * Las condiciones de Places solo permiten guardar el place_id: la foto y su URL
 * no se pueden almacenar. fotos-places.js guarda en `imagen_google` el place_id
 * y qué foto se verificó (autor y tamaño); aquí se vuelve a pedir esa foto a
 * Google y se redirige a su URL temporal.
 *
 * Caché en memoria (corta, como permite Places) para no pagar una petición
 * por cada vez que alguien ve la tarjeta.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const TTL_MS = 50 * 60000; // las URLs de foto de Google caducan; se renuevan antes
const MAX_ENTRADAS = 2000;
const cache = new Map(); // id → { url, autor, autorUri, hasta }

function guardar(id, valor) {
  cache.set(id, { ...valor, hasta: Date.now() + TTL_MS });
  if (cache.size > MAX_ENTRADAS) cache.delete(cache.keys().next().value);
}

/** De las fotos actuales del lugar, la verificada (mismo autor y tamaño) o, si cambió, la del mismo autor. */
function elegirFoto(fotos = [], g = {}) {
  const autor = (f) => f.authorAttributions?.[0]?.uri || null;
  return fotos.find((f) => autor(f) === g.autorUri && f.widthPx === g.ancho && f.heightPx === g.alto)
    || fotos.find((f) => g.autorUri && autor(f) === g.autorUri)
    || null;
}

/**
 * Devuelve { url, autor, autorUri } o null si el restaurante no tiene foto de
 * Google, falta la clave o la foto verificada ya no existe (el cliente usa su imagen de respaldo).
 */
async function urlFotoGoogle(id, { fetchFn = fetch } = {}) {
  const enCache = cache.get(id);
  if (enCache && enCache.hasta > Date.now()) return enCache;
  const clave = process.env.GOOGLE_PLACES_API_KEY;
  if (!clave) return null;

  const doc = await db.collection("restaurants").doc(String(id)).get();
  const g = doc.exists ? doc.data().imagen_google : null;
  if (!g?.placeId) return null;

  try {
    const lugar = await fetchFn(`https://places.googleapis.com/v1/places/${encodeURIComponent(g.placeId)}`, {
      headers: { "X-Goog-Api-Key": clave, "X-Goog-FieldMask": "photos" },
    });
    if (!lugar.ok) throw new Error(`Place Details ${lugar.status}`);
    const foto = elegirFoto((await lugar.json()).photos || [], g);
    if (!foto) {
      // La foto verificada ya no está en Google: no se sirve otra sin verificar.
      guardar(id, { url: null });
      return null;
    }
    const media = await fetchFn(`https://places.googleapis.com/v1/${foto.name}/media?maxWidthPx=1200&skipHttpRedirect=true`, {
      headers: { "X-Goog-Api-Key": clave },
    });
    if (!media.ok) throw new Error(`Place Photo ${media.status}`);
    const { photoUri } = await media.json();
    const valor = { url: photoUri, autor: g.autor || null, autorUri: g.autorUri || null };
    guardar(id, valor);
    return valor;
  } catch (err) {
    logger.warn({ id, err: err.message }, "foto de Google no disponible");
    return null;
  }
}

function _reset() {
  cache.clear();
}

module.exports = { urlFotoGoogle, elegirFoto, _reset };
