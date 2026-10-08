/**
 * Lógica pura de fotos-places.js (sin red ni Firestore): qué restaurantes
 * necesitan foto, cómo emparejar el local en Google Places y cómo decidir
 * si una foto vale a partir del veredicto de Gemini. Se testea con node --test.
 */

/** Normaliza para comparar nombres: minúsculas, sin tildes ni signos. */
function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(restaurant|restaurante|bar|el|la|les|els|los|las|de|del|i|y|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similitud de nombres 0..1 (Jaccard de palabras + bonus si uno contiene al otro). */
function similitudNombre(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = new Set(na.split(' '));
  const B = new Set(nb.split(' '));
  const comunes = [...A].filter((x) => B.has(x)).length;
  const jaccard = comunes / new Set([...A, ...B]).size;
  const contiene = na.includes(nb) || nb.includes(na) ? 0.3 : 0;
  return Math.min(1, jaccard + contiene);
}

/** Distancia en metros entre dos coordenadas (haversine). */
function distanciaM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coordsDe(r) {
  const c = r.coordenadas || r.coords || {};
  const lat = Number(c.latitud ?? c.lat);
  const lng = Number(c.longitud ?? c.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Restaurantes que necesitan foto y por qué:
 * - 'sin_foto': Yelp no dio imagen.
 * - 'duplicada': su imagen la comparten 2+ restaurantes.
 * - 'stock': foto genérica de un banco de imágenes (Pexels, loremflickr…), no es del local.
 *   loremflickr repite las mismas fotos con URLs distintas (?lock=), por eso no
 *   basta con buscar URLs repetidas: se reconoce por la fuente o por el dominio.
 * Las ya resueltas por este script (google_places / ia) se saltan salvo `forzar`.
 */
const FUENTES_STOCK = new Set(['pexels', 'loremflickr', 'unsplash', 'picsum', 'stock']);
const DOMINIOS_STOCK = /(^|\.)(loremflickr\.com|pexels\.com|picsum\.photos|unsplash\.com|placehold\.co|placeimg\.com)$/i;

/** ¿La imagen es de un banco de fotos genéricas? Por la fuente guardada o, si no hay, por el dominio. */
function esStock(r) {
  if (FUENTES_STOCK.has(String(r.imagen_fuente || '').toLowerCase())) return true;
  try {
    return DOMINIOS_STOCK.test(new URL(r.imagen_url).hostname);
  } catch {
    return false;
  }
}

function seleccionarCandidatos(restaurantes, { incluirStock = true, forzar = false } = {}) {
  const usos = new Map();
  for (const r of restaurantes) {
    if (r.imagen_url) usos.set(r.imagen_url, (usos.get(r.imagen_url) || 0) + 1);
  }
  const out = [];
  for (const r of restaurantes) {
    if (!forzar && ['google_places', 'ia'].includes(r.imagen_fuente)) continue;
    let motivo = null;
    if (!r.imagen_url) motivo = 'sin_foto';
    else if (usos.get(r.imagen_url) > 1) motivo = 'duplicada';
    else if (incluirStock && esStock(r)) motivo = 'stock';
    if (motivo) out.push({ ...r, motivo });
  }
  // Primero los que peor están: sin foto > duplicada > stock.
  const prioridad = { sin_foto: 0, duplicada: 1, stock: 2 };
  return out.sort((a, b) => prioridad[a.motivo] - prioridad[b.motivo]);
}

/**
 * Elige el resultado de Places que es de verdad este restaurante:
 * nombre parecido (≥ 0,5) y a menos de `maxM` metros si conocemos coordenadas.
 * Devuelve { place, similitud, distancia } o null.
 */
function emparejarLugar(restaurante, places = [], { maxM = 250 } = {}) {
  const origen = coordsDe(restaurante);
  let mejor = null;
  for (const p of places) {
    const nombre = p.displayName?.text || p.displayName || '';
    const sim = similitudNombre(restaurante.nombre, nombre);
    const dest = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
    const dist = origen && dest ? distanciaM(origen, dest) : null;
    if (sim < 0.5) continue;
    if (dist != null && dist > maxM) continue;
    const puntos = sim - (dist != null ? dist / maxM / 4 : 0.1); // sin coordenadas, un poco menos de confianza
    if (!mejor || puntos > mejor.puntos) mejor = { place: p, similitud: sim, distancia: dist, puntos };
  }
  return mejor;
}

const CATEGORIAS_OK = ['fachada', 'interior', 'plato'];

/** Prompt de verificación: la respuesta debe ser SOLO un JSON con este formato. */
const PROMPT_VERIFICACION = `Eres un revisor de fotos para una guía de restaurantes.
Mira la imagen y responde SOLO con JSON, sin texto alrededor, con este formato:
{"categoria":"fachada|interior|plato|bebida|personas|menu|logo|otro","personasPrimerPlano":true|false,"textoDominante":true|false,"calidad":1-5,"motivo":"frase corta"}
- "fachada": exterior del local. "interior": comedor, barra o sala. "plato": comida servida.
- personasPrimerPlano = true si alguna persona es protagonista o se le ve la cara claramente.
- textoDominante = true si es sobre todo un menú, carta, cartel, captura o documento.
- calidad: 1 borrosa/oscura … 5 nítida y bien encuadrada.`;

/** Lee el JSON que devuelve Gemini aunque venga envuelto en ```json … ```. */
function parsearVeredicto(texto) {
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return {
      categoria: String(v.categoria || 'otro').toLowerCase(),
      personasPrimerPlano: Boolean(v.personasPrimerPlano),
      textoDominante: Boolean(v.textoDominante),
      calidad: Number(v.calidad) || 0,
      motivo: String(v.motivo || '').slice(0, 200),
    };
  } catch {
    return null;
  }
}

/** ¿Vale la foto? Solo local o comida, sin personas protagonistas ni texto, y con calidad ≥ 3. */
function fotoValida(v) {
  if (!v) return { ok: false, motivo: 'sin veredicto' };
  if (v.personasPrimerPlano) return { ok: false, motivo: 'personas en primer plano' };
  if (v.textoDominante) return { ok: false, motivo: 'menú, cartel o texto' };
  if (!CATEGORIAS_OK.includes(v.categoria)) return { ok: false, motivo: `categoría ${v.categoria}` };
  if (v.calidad < 3) return { ok: false, motivo: `calidad ${v.calidad}` };
  return { ok: true, motivo: v.motivo };
}

/** Entre las válidas, prefiere fachada/interior (identifican el local) y luego la de más calidad. */
function elegirMejor(validas) {
  const peso = { fachada: 3, interior: 2, plato: 1 };
  return [...validas].sort((a, b) => (peso[b.veredicto.categoria] - peso[a.veredicto.categoria]) || (b.veredicto.calidad - a.veredicto.calidad))[0] || null;
}

/** Prompt para generar una foto cuando Google no da ninguna válida (sin personas, texto ni logos). */
function promptGeneracion(r) {
  const cocina = (r.categorias || []).slice(0, 2).join(' y ') || 'mediterránea';
  const precio = { '€': 'informal y sencillo', '€€': 'cuidado y acogedor', '€€€': 'elegante y de alta cocina' }[r.precio] || 'acogedor';
  return `Fotografía realista y apetecible de un plato típico de cocina ${cocina}, servido en un restaurante ${precio} de ${r.ciudad || 'Cataluña'}. `
    + 'Luz natural cálida, plano cenital o a 45 grados, fondo de mesa desenfocado. '
    + 'Sin personas, sin manos, sin texto, sin logotipos ni marcas de agua. Formato horizontal 16:10.';
}

module.exports = {
  esStock, normalizar, similitudNombre, distanciaM, coordsDe, seleccionarCandidatos, emparejarLugar,
  PROMPT_VERIFICACION, parsearVeredicto, fotoValida, elegirMejor, promptGeneracion, CATEGORIAS_OK,
};
