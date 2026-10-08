/**
 * fotos-places.js — foto real del restaurante para los que no tienen, la tienen
 * repetida o usan una genérica de Pexels.
 *
 * Flujo por restaurante:
 *  1. Google Places (API oficial, "Text Search") localiza el local por nombre +
 *     dirección y se comprueba que es el mismo (nombre parecido y < 250 m).
 *  2. Cada foto candidata se pasa a Gemini, que dice si es fachada, interior o
 *     plato y si hay personas en primer plano o texto. Solo se acepta si es del
 *     local o su comida, sin personas protagonistas y con calidad suficiente.
 *  3. Si ninguna vale, se genera una imagen con Gemini (sin personas ni texto),
 *     se vuelve a verificar y se sube a Firebase Storage.
 *
 * Qué se guarda (condiciones de Google Places): solo el place_id y los datos de
 * la foto elegida (autor, tamaño, categoría). La foto en sí la sirve la API en
 * GET /v1/restaurants/:id/foto, que la pide a Google al vuelo. Las generadas
 * con IA son nuestras: van a Storage y su URL queda en imagen_url.
 *
 * Uso (las claves van en el entorno o en yelp-connection/.env, nunca en el repo):
 *   node fotos-places.js --listar                 → solo cuenta candidatos (0 llamadas de pago)
 *   node fotos-places.js                          → PRUEBA con 5: llama a las APIs y no escribe nada
 *   node fotos-places.js --aplicar --limite=50    → escribe en Firestore (con copia para deshacer)
 *   node fotos-places.js --deshacer=backups/fotos-XXXX.json
 * Opciones: --limite=N  --sin-ia  --sin-stock  --forzar  --solo=<id>
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');
const lib = require('./fotos-places-lib.js');

try { require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((l) => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch { /* sin .env */ }

const CRED = path.resolve(__dirname, './serviceAccountKey.json');
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODELO_VISION = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const MODELO_IMAGEN = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'restaurante-mira-18e0c.firebasestorage.app';
const MAX_FOTOS_POR_LOCAL = 5;
const PAUSA_MS = 300;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const APLICAR = Boolean(args.aplicar);
const LIMITE = Number(args.limite) || (APLICAR ? 50 : 5);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── APIs externas ───────── */

async function placesBuscar(r) {
  const c = lib.coordsDe(r);
  const body = {
    textQuery: [r.nombre, r.direccion_completa || r.direccion, r.ciudad].filter(Boolean).join(', '),
    languageCode: 'es',
    maxResultCount: 3,
    ...(c ? { locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: 300 } } } : {}),
  };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.photos',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places searchText ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).places || [];
}

/** URL temporal de la foto (no se guarda: solo sirve para descargarla y verificarla ahora). */
async function placesUrlFoto(nombreFoto, ancho = 1200) {
  const res = await fetch(`https://places.googleapis.com/v1/${nombreFoto}/media?maxWidthPx=${ancho}&skipHttpRedirect=true`, {
    headers: { 'X-Goog-Api-Key': PLACES_KEY },
  });
  if (!res.ok) throw new Error(`Places photo ${res.status}`);
  return (await res.json()).photoUri;
}

async function descargar(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga ${res.status}`);
  return { datos: Buffer.from(await res.arrayBuffer()), tipo: res.headers.get('content-type') || 'image/jpeg' };
}

async function gemini(modelo, partes, config = {}) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({ contents: [{ parts: partes }], generationConfig: config }),
  });
  if (!res.ok) throw new Error(`Gemini ${modelo} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function verificar({ datos, tipo }) {
  const r = await gemini(MODELO_VISION, [
    { text: lib.PROMPT_VERIFICACION },
    { inline_data: { mime_type: tipo, data: datos.toString('base64') } },
  ], { temperature: 0, responseMimeType: 'application/json' });
  const texto = r.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return lib.parsearVeredicto(texto);
}

async function generar(r) {
  const prompt = lib.promptGeneracion(r);
  const resp = await gemini(MODELO_IMAGEN, [{ text: prompt }], { responseModalities: ['IMAGE'] });
  const parte = resp.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const inline = parte?.inlineData || parte?.inline_data;
  if (!inline?.data) throw new Error('Gemini no devolvió imagen');
  return { datos: Buffer.from(inline.data, 'base64'), tipo: inline.mimeType || inline.mime_type || 'image/png', prompt };
}

async function subirStorage(id, { datos, tipo }) {
  const ext = tipo.includes('jpeg') ? 'jpg' : 'png';
  const ruta = `restaurantes/ia/${id}.${ext}`;
  const token = crypto.randomUUID();
  await admin.storage().bucket(BUCKET).file(ruta).save(datos, {
    contentType: tipo,
    metadata: { cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token, origen: 'ia' } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(ruta)}?alt=media&token=${token}`;
}

/* ───────── Un restaurante ───────── */

async function resolver(r, { permitirIa }) {
  const traza = { id: r.id, nombre: r.nombre, motivo: r.motivo, intentos: [] };
  if (PLACES_KEY) {
    const places = await placesBuscar(r);
    const m = lib.emparejarLugar(r, places);
    traza.place = m ? { id: m.place.id, nombre: m.place.displayName?.text, similitud: Math.round(m.similitud * 100) / 100, distanciaM: m.distancia == null ? null : Math.round(m.distancia) } : null;
    const validas = [];
    for (const foto of (m?.place.photos || []).slice(0, MAX_FOTOS_POR_LOCAL)) {
      try {
        const veredicto = await verificar(await descargar(await placesUrlFoto(foto.name)));
        const decision = lib.fotoValida(veredicto);
        traza.intentos.push({ autor: foto.authorAttributions?.[0]?.displayName || null, categoria: veredicto?.categoria, ok: decision.ok, motivo: decision.motivo });
        if (decision.ok) validas.push({ foto, veredicto });
        if (validas.some((v) => v.veredicto.categoria === 'fachada')) break; // ya hay la mejor posible
      } catch (e) {
        traza.intentos.push({ ok: false, motivo: e.message });
      }
      await espera(PAUSA_MS);
    }
    const mejor = lib.elegirMejor(validas);
    if (mejor) {
      const a = mejor.foto.authorAttributions?.[0] || {};
      traza.resultado = 'google_places';
      traza.cambios = {
        imagen_url: null,
        imagen_fuente: 'google_places',
        imagen_google: {
          placeId: m.place.id,
          autor: a.displayName || null,
          autorUri: a.uri || null,
          ancho: mejor.foto.widthPx || null,
          alto: mejor.foto.heightPx || null,
          categoria: mejor.veredicto.categoria,
          calidad: mejor.veredicto.calidad,
          verificadaEn: new Date().toISOString(),
        },
      };
      return traza;
    }
  }
  if (!permitirIa) { traza.resultado = 'sin_cambios'; return traza; }

  // Generada con IA: hasta 2 intentos, verificando también que no salgan personas ni texto.
  for (let i = 0; i < 2; i++) {
    try {
      const img = await generar(r);
      const veredicto = await verificar(img);
      const decision = lib.fotoValida(veredicto);
      traza.intentos.push({ ia: true, categoria: veredicto?.categoria, ok: decision.ok, motivo: decision.motivo });
      if (!decision.ok) continue;
      traza.resultado = 'ia';
      traza.imagenIa = img;
      traza.cambios = {
        imagen_fuente: 'ia',
        imagen_ia: { modelo: MODELO_IMAGEN, prompt: img.prompt, generadaEn: new Date().toISOString() },
      };
      return traza;
    } catch (e) {
      traza.intentos.push({ ia: true, ok: false, motivo: e.message });
    }
  }
  traza.resultado = 'sin_cambios';
  return traza;
}

/* ───────── Deshacer ───────── */

async function deshacer(db, archivo) {
  const copia = JSON.parse(fs.readFileSync(path.resolve(__dirname, archivo), 'utf8'));
  const del = admin.firestore.FieldValue.delete();
  let n = 0;
  for (const [id, antes] of Object.entries(copia.documentos)) {
    await db.collection('restaurants').doc(id).update({
      imagen_url: antes.imagen_url ?? null,
      imagen_fuente: antes.imagen_fuente ?? del,
      imagen_google: antes.imagen_google ?? del,
      imagen_ia: antes.imagen_ia ?? del,
    });
    n++;
  }
  console.log(`↩️  Restaurados ${n} restaurantes desde ${archivo}.`);
}

/* ───────── Principal ───────── */

async function main() {
  if (!fs.existsSync(CRED)) throw new Error('Falta yelp-connection/serviceAccountKey.json (no se sube al repo).');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(CRED)), storageBucket: BUCKET });
  const db = admin.firestore();

  if (args.deshacer) return deshacer(db, args.deshacer);

  const snap = await db.collection('restaurants')
    .select('nombre', 'direccion_completa', 'ciudad', 'categorias', 'precio', 'coordenadas', 'imagen_url', 'imagen_fuente').get();
  const todos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  let candidatos = lib.seleccionarCandidatos(todos, { incluirStock: !args['sin-stock'], forzar: Boolean(args.forzar) });
  if (args.solo) candidatos = candidatos.filter((r) => r.id === args.solo);
  const porMotivo = candidatos.reduce((m, r) => ({ ...m, [r.motivo]: (m[r.motivo] || 0) + 1 }), {});
  console.log(`📷 ${todos.length} restaurantes · ${candidatos.length} necesitan foto`, porMotivo);
  if (args.listar || !candidatos.length) return;

  const permitirIa = !args['sin-ia'] && Boolean(GEMINI_KEY);
  if (!GEMINI_KEY) throw new Error('Falta GEMINI_API_KEY: sin ella no se puede verificar que la foto sea del restaurante.');
  if (!PLACES_KEY) console.log('⚠️  Sin GOOGLE_PLACES_API_KEY: solo se generarán imágenes con IA.');
  console.log(APLICAR ? `✍️  Modo APLICAR (máx. ${LIMITE})` : `🧪 Modo PRUEBA (máx. ${LIMITE}, no se escribe nada). Añade --aplicar para guardar.`);

  const lote = candidatos.slice(0, LIMITE);
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const copia = { creado: new Date().toISOString(), documentos: {} };
  const informe = [];

  for (const r of lote) {
    let traza;
    try {
      traza = await resolver(r, { permitirIa });
    } catch (e) {
      traza = { id: r.id, nombre: r.nombre, motivo: r.motivo, resultado: 'error', error: e.message };
    }
    console.log(`  ${traza.resultado === 'google_places' ? '✅' : traza.resultado === 'ia' ? '🎨' : '⏭️ '} ${r.nombre} (${r.motivo}) → ${traza.resultado}${traza.error ? `: ${traza.error}` : ''}`);

    if (APLICAR && traza.cambios) {
      const actual = todos.find((x) => x.id === r.id);
      copia.documentos[r.id] = { imagen_url: actual.imagen_url ?? null, imagen_fuente: actual.imagen_fuente ?? null, imagen_google: actual.imagen_google ?? null, imagen_ia: actual.imagen_ia ?? null };
      // La copia se escribe ANTES de tocar Firestore: si algo falla a medias, se puede deshacer igual.
      fs.mkdirSync(path.join(__dirname, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'backups', `fotos-${sello}.json`), JSON.stringify(copia, null, 2));
      const cambios = { ...traza.cambios };
      if (traza.imagenIa) cambios.imagen_url = await subirStorage(r.id, traza.imagenIa);
      await db.collection('restaurants').doc(r.id).update(cambios);
    }
    delete traza.imagenIa;
    informe.push(traza);
    await espera(PAUSA_MS);
  }

  fs.mkdirSync(path.join(__dirname, 'informes'), { recursive: true });
  const archivo = path.join('informes', `fotos-${sello}.json`);
  fs.writeFileSync(path.join(__dirname, archivo), JSON.stringify(informe, null, 2));
  const cuenta = (x) => informe.filter((t) => t.resultado === x).length;
  console.log(`\nResumen: ${cuenta('google_places')} con foto de Google · ${cuenta('ia')} generadas con IA · ${cuenta('sin_cambios')} sin cambios · ${cuenta('error')} errores`);
  console.log(`Informe: ${archivo}${APLICAR && Object.keys(copia.documentos).length ? ` · Para deshacer: node fotos-places.js --deshacer=backups/fotos-${sello}.json` : ''}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { resolver };
