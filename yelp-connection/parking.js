/**
 * parking.js - Parkings cercanos con Overpass API (Node 18+, sin claves).
 * Lógica pura + fetch, reutilizable desde recordatorios.js.
 * Si Overpass falla, devuelve [] (el recordatorio sale igual, sin parking).
 */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nombreParking(tags) {
  if (!tags) return 'Parking';
  return (
    tags.name ||
    tags.operator ||
    (tags['addr:street'] ? `Parking ${tags['addr:street']}` : null) ||
    (tags.parking ? `Parking (${tags.parking})` : 'Parking')
  );
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ radio?: number, limite?: number }} opts
 * @returns {Promise<{ nombre:string, lat:number, lng:number, distanciaM:number }[]>}
 */
async function buscarParkingsCercanos(lat, lng, { radio = 1000, limite = 3 } = {}) {
  if (lat == null || lng == null) return [];
  // Radios progresivos: en pueblos OSM tiene pocos parkings mapeados.
  const radios = radio < 1000 ? [radio, 1200, 2000] : radio <= 1500 ? [radio, 2000, 3000] : [radio];
  let ultimo = [];
  for (const r of radios) {
    const res = await consultar(lat, lng, r, limite);
    if (res.length > 0) return res;
    ultimo = res;
  }
  return ultimo;
}

async function consultar(lat, lng, radio, limite) {
  // Búsqueda amplia: amenity=parking + parking_space + parking=*.
  // Antes solo amenity="parking" y se perdían parkings subterráneos/privados.
  const ql = `[out:json][timeout:25];(nwr["amenity"~"^(parking|parking_space)$"](around:${radio},${lat},${lng});nwr["parking"](around:${radio},${lat},${lng}););out center ${Math.min(40, limite * 8)};`;
  const qs = `data=${encodeURIComponent(ql)}`;
  for (const base of OVERPASS_ENDPOINTS) {
    const url = `${base}?${qs}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'restaurante-mira/1.0 (node)' },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status === 504) continue;
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith('<')) continue;
      const json = JSON.parse(text);
      const els = Array.isArray(json.elements) ? json.elements : [];
      return els
        .map((e) => {
          const plat = e.lat ?? e.center?.lat;
          const plng = e.lon ?? e.center?.lon;
          if (plat == null || plng == null) return null;
          return {
            nombre: nombreParking(e.tags),
            lat: plat,
            lng: plng,
            distanciaM: Math.round(haversineM(lat, lng, plat, plng)),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanciaM - b.distanciaM)
        .slice(0, limite);
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  return [];
}

function textoDistancia(m) {
  if (m == null) return '';
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`;
}

module.exports = { buscarParkingsCercanos, textoDistancia };
