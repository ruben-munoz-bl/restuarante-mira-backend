/**
 * Restaurante_Mira - Script Node.js: Yelp -> Faker -> Firebase
 * -------------------------------------------------
 * 1. Conexión a Yelp (fetch nativo Node 18+) y mapeo a campos esenciales.
 * 2. Generación de 50 reseñas sintéticas por restaurante con @faker-js/faker.
 * 3. Subida a Firebase con firebase-admin (Firestore por defecto).
 *
 * Instalación (ya hecha):
 *   npm.cmd install firebase-admin @faker-js/faker
 * Ejecución:
 *   node index.js
 */

// =====================================================
// 1. CONFIGURACIÓN - EDITA AQUÍ TUS DATOS
// =====================================================

// --- YELP (tu clave ya puesta) ---
const YELP_API_KEY = process.env.YELP_API_KEY || 'CeXz-JTwa31IQXUV9Q7Zz9tHd6MHjUtivTbnlyza3Hg2yDHPlOid_J74I_Fs7fZn2T9P7Vg45l-ixM6NotXEbq3s01ilpBL34rZL2axf8XZyBP1PjhyjIeVAoOCfanYx';
const YELP_SEARCH_TERM = 'restaurants';      // prueba con 'sushi', 'tapas', 'italian', etc.
// SOLO CATALUÑA con tope 240 por ciudad (máximo que Yelp deja paginar: limit+offset<=240)
const CIUDADES = [
  'Barcelona, Spain',
  'Tarragona, Spain',
  'Girona, Spain',
  'Lleida, Spain',
];
const YELP_LIMIT = 50;                       // máx por petición Yelp (50)
const YELP_MAX_TOTAL = 240;                  // CAP 240 por ciudad (tope real de paginación Yelp)
const YELP_SORT_BY = 'best_match';           // 'best_match' | 'rating' | 'review_count' | 'distance'

// --- RESEÑAS SINTÉTICAS ---
const NUM_REVIEWS_POR_RESTAURANTE = 50;

// --- MOTOR DE RESEÑAS: 'faker' (gratis, local) o 'gemini' (IA, tier gratis) ---
// Gemini gratis: consigue la clave en https://aistudio.google.com/apikey
//   PowerShell: $env:REVIEW_MOTOR="gemini"; $env:GEMINI_API_KEY="tu_clave"; node index.js
// Para probar la IA barato con 1 sola ciudad: $env:SOLO_CIUDAD="lleida"
const REVIEW_MOTOR = process.env.REVIEW_MOTOR || 'faker'; // 'faker' | 'gemini'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash';
const REVIEW_CONCURRENCIA = 3; // llamadas IA en paralelo (el tier gratis admite ~15/min)

// --- FIREBASE (para cambiar de BBDD solo sustituye 'serviceAccountKey.json') ---
// 1. Firebase Console > Configuración del proyecto > Cuentas de servicio
// 2. Generar clave privada y guardarla como 'serviceAccountKey.json' en esta misma carpeta
// 3. NO subir ese archivo a Git
// El proyecto se detecta SOLO desde serviceAccountKey.json: al cambiar de BBDD no hay
// que tocar nada más aquí (databaseURL solo haría falta para Realtime Database).
const FIREBASE_SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
const FIREBASE_DATABASE_URL = ''; // opcional, solo Realtime Database. Firestore lo ignora.
const FIRESTORE_COLLECTION = 'restaurants';

// Si no hay credenciales, guarda JSON local en vez de fallar (para probar sin Firebase)
const GUARDAR_BACKUP_LOCAL_SI_NO_HAY_FIREBASE = true;

// =====================================================
// 2. IMPORTS
// =====================================================
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { fakerES: faker } = require('@faker-js/faker');

// =====================================================
// 3. YELP: FETCH + MAPEO
// =====================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchRestaurantesDeYelp() {
  if (!YELP_API_KEY || YELP_API_KEY === 'TU_YELP_API_KEY_AQUI') {
    console.log('⚠️  Sin YELP_API_KEY. Usando datos de ejemplo.');
    return getRestaurantesMock();
  }

  // Multi-ciudad: recorre CIUDADES, pagina cada una y deduplica global por id.
  // Para pruebas baratas: SOLO_CIUDAD=lleida limita a las que contengan ese texto.
  const ciudadesEfectivas = process.env.SOLO_CIUDAD
    ? CIUDADES.filter((c) => c.toLowerCase().includes(process.env.SOLO_CIUDAD.toLowerCase()))
    : CIUDADES;
  if (!ciudadesEfectivas.length) throw new Error(`SOLO_CIUDAD="${process.env.SOLO_CIUDAD}" no coincide con ninguna ciudad`);
  const todosGlobal = [];
  const vistosGlobal = new Set();

  for (const ciudadQuery of ciudadesEfectivas) {
    const deCiudad = await fetchCiudad(ciudadQuery, vistosGlobal);
    todosGlobal.push(...deCiudad);
    console.log(`🏙️  ${ciudadQuery}: +${deCiudad.length} (acumulado España: ${todosGlobal.length})`);
    await sleep(500); // pausa entre ciudades para cuidar cuota
  }

  console.log(`✅ Total España únicos: ${todosGlobal.length} en ${CIUDADES.length} ciudades`);
  return todosGlobal;
}

// Paginación con offset para UNA ciudad (Yelp da máx 50 por llamada, cap 240 en esta búsqueda)
async function fetchCiudad(YELP_LOCATION, vistosGlobal) {
  // Paginación con offset para traer TODOS los posibles (Yelp da máx 50 por llamada, 1000 en total)
  const todos = [];
  let offset = 0;
  let totalEsperado = Infinity;

  console.log(`🔎 Yelp: term="${YELP_SEARCH_TERM}" location="${YELP_LOCATION}" (paginando de ${YELP_LIMIT} en ${YELP_LIMIT} hasta ${YELP_MAX_TOTAL})...`);

  while (offset < YELP_MAX_TOTAL) {
    // Yelp en esta búsqueda exige limit+offset <= 240 -> ajustamos el limit final
    const LIMITE_DURO_YELP = 240;
    let limiteEfectivo = Math.min(YELP_LIMIT, LIMITE_DURO_YELP - offset);
    if (totalEsperado !== Infinity) limiteEfectivo = Math.min(limiteEfectivo, totalEsperado - todos.length);
    if (limiteEfectivo <= 0) break;

    const url = `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(
      YELP_SEARCH_TERM
    )}&location=${encodeURIComponent(YELP_LOCATION)}&limit=${limiteEfectivo}&offset=${offset}&sort_by=${YELP_SORT_BY}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${YELP_API_KEY}`, Accept: 'application/json' },
    });

    if (!res.ok) {
      const texto = await res.text();
      // Si es 429 (cuota), espera y reintenta una vez
      if (res.status === 429) {
        console.log('⏳ Rate limit 429, esperando 5s y reintentando...');
        await sleep(5000);
        continue;
      }
      // Si Yelp dice que ya no hay más (cap 240), devolvemos lo conseguido en vez de fallar todo
      if (res.status === 400 && texto.includes('Too many results')) {
        console.log(`⚠️  Yelp cap alcanzado en offset=${offset}. Devolvemos ${todos.length} conseguidos.`);
        break;
      }
      throw new Error(`Error Yelp ${res.status} en offset ${offset}: ${texto}`);
    }

    const json = await res.json();
    const lote = json.businesses || [];

    // Yelp informa el total (capado a 1000). Lo respetamos junto a YELP_MAX_TOTAL.
    if (totalEsperado === Infinity && typeof json.total === 'number') {
      totalEsperado = Math.min(json.total, YELP_MAX_TOTAL, 1000);
      console.log(`📊 Yelp informa total=${json.total}. Objetivo a descargar: ${totalEsperado}.`);
    }

    // Deduplicar global por id (entre paginación y entre ciudades)
    let nuevos = 0;
    for (const b of lote) {
      if (!b?.id || vistosGlobal.has(b.id)) continue;
      vistosGlobal.add(b.id);
      b._zona_busqueda = YELP_LOCATION; // para dividir España por zona
      todos.push(b);
      nuevos++;
    }

    console.log(`   offset=${offset} -> recibidos ${lote.length}, nuevos ${nuevos}, acumulado ${todos.length}/${totalEsperado}`);

    // Parar solo si no hay más datos o llegamos al objetivo.
    // NO parar por lote < limit: Yelp a veces devuelve 49/50 aun quedando más.
    if (lote.length === 0 || todos.length >= totalEsperado) break;

    offset += YELP_LIMIT;
    // Si Yelp devuelve menos de los pedidos pero dice que hay más, seguimos igual con offset+limit
    await sleep(300); // pequeña pausa para cuidar la cuota
  }

  console.log(`✅ Total únicos descargados de Yelp (${YELP_LOCATION}): ${todos.length}`);
  return todos;
}

// Nos quedamos SOLO con los campos esenciales
function mapearRestaurante(b) {
  return {
    yelp_id: b.id,
    nombre: b.name,
    zona_busqueda: b._zona_busqueda || '', // ciudad de la query (para dividir España)
    direccion: b.location?.address1 || '',
    ciudad: b.location?.city || '',
    codigo_postal: b.location?.zip_code || '',
    pais: b.location?.country || '',
    direccion_completa: (b.location?.display_address || []).join(', '),
    telefono: b.display_phone || b.phone || '',
    coordenadas: {
      latitud: b.coordinates?.latitude ?? null,
      longitud: b.coordinates?.longitude ?? null,
    },
    rating_yelp: b.rating ?? null,
    total_resenas_yelp: b.review_count ?? 0,
    precio: b.price || null,
    categorias: (b.categories || []).map((c) => c.title),
    imagen_url: b.image_url || null,
    yelp_url: b.url || null,
    resenas: [], // se rellena con Faker
  };
}

function getRestaurantesMock() {
  return [
    {
      id: 'mock-casa-lucio', name: 'Casa Lucio Demo',
      location: { address1: 'Cava Baja 35', city: 'Madrid', zip_code: '28005', country: 'ES', display_address: ['Cava Baja 35', '28005 Madrid'] },
      display_phone: '+34 913 65 32 52', coordinates: { latitude: 40.412, longitude: -3.708 },
      rating: 4.5, review_count: 1200, price: '€€',
      categories: [{ title: 'Española' }], image_url: null, url: null,
    },
  ];
}

// =====================================================
// 4. FAKER: 50 RESEÑAS POR RESTAURANTE
// =====================================================

const PLANTILLAS_COMENTARIOS = [
  'La comida estaba {adj}, el servicio {servicio} y el local muy {ambiente}. Volveremos seguro.',
  '{plato} espectacular. {detalle} Muy recomendable para ir en {compania}.',
  'Reservamos para {compania} y todo perfecto. El {plato} es de lo mejor que he probado en {ciudad}.',
  'Calidad-precio {valoracion}. El trato fue {servicio} y tardaron poco en servir.',
  'No me convenció del todo. El {plato} estaba {adj_neg} y había mucho ruido. Aun así, el personal fue {servicio}.',
  'Uno de mis sitios favoritos en {ciudad}. El {plato} siempre sale {adj}. Ideal para {compania}.',
  'Fuimos a {nombre} ({ciudad}) y {plato} estaba {adj}. Servicio {servicio}, repetiremos seguro.',
  '{nombre} no falla: {plato} {adj} y trato {servicio}. Perfecto para ir en {compania}.',
];
const ADJETIVOS_POS = ['riquísima', 'exquisita', 'increíble', 'deliciosa', 'perfecta', 'muy fresca'];
const ADJETIVOS_NEG = ['frío', 'soso', 'algo seco', 'mejorable'];
const SERVICIOS = ['rapidísimo y amable', 'atento', 'muy profesional', 'correcto', 'de 10'];
const AMBIENTES = ['acogedor', 'limpio', 'bonito', 'tranquilo', 'moderno'];
const COMPANIAS = ['familia', 'pareja', 'amigos', 'compañeros de trabajo'];

// Platos típicos según el estilo de cocina (categorías de Yelp) -> la reseña menciona
// lo que de verdad sirve ese restaurante en vez de un plato genérico.
const PLATOS_POR_COCINA = [
  { match: ['sushi', 'japon'], platos: ['el nigiri de salmón', 'el ramen', 'el chirashi', 'la gyoza', 'el maki de atún'] },
  { match: ['italian', 'pizza', 'pasta'], platos: ['la carbonara', 'la pizza margarita', 'el risotto', 'la lasaña', 'el tiramisú'] },
  { match: ['tapas', 'espa', 'mediterr', 'catalan'], platos: ['la paella', 'el jamón ibérico', 'las bravas', 'el pulpo', 'la tortilla', 'los calçots'] },
  { match: ['mexican', 'taco'], platos: ['los tacos al pastor', 'el burrito', 'las quesadillas', 'el guacamole'] },
  { match: ['chinese', 'china', 'wok', 'canton', 'asian'], platos: ['el pato laqueado', 'los dim sum', 'el arroz tres delicias', 'los tallarines'] },
  { match: ['indian', 'india', 'curry'], platos: ['el pollo tikka masala', 'el curry de cordero', 'el naan', 'el biryani'] },
  { match: ['burger', 'hamburg'], platos: ['la hamburguesa doble', 'las patatas trufadas', 'los aros de cebolla'] },
  { match: ['seafood', 'marisc', 'pescado', 'fish'], platos: ['la lubina a la espalda', 'el arroz con bogavante', 'los mejillones', 'el ceviche'] },
  { match: ['steak', 'grill', 'parrilla', 'asador', 'barbecue'], platos: ['el entrecot', 'el chuletón', 'las costillas', 'el steak tartar'] },
  { match: ['french', 'franc'], platos: ['el confit de pato', 'la sopa de cebolla', 'el steak frites'] },
  { match: ['greek', 'grieg'], platos: ['la musaka', 'el giros', 'la ensalada griega'] },
  { match: ['kebab', 'turk', 'leban', 'arab'], platos: ['el kebab mixto', 'el falafel', 'el hummus'] },
  { match: ['thai', 'vietnam'], platos: ['el pad thai', 'el curry verde', 'la sopa tom yum'] },
  { match: ['dessert', 'postre', 'helad', 'pastel', 'bakery', 'crep'], platos: ['la tarta de queso', 'el coulant', 'el helado artesano', 'los creps'] },
  { match: ['breakfast', 'brunch', 'caf'], platos: ['el brunch completo', 'los huevos benedict', 'el café de especialidad', 'la tostada con tomate'] },
];
const PLATOS_GENERICOS = ['el plato del día', 'el menú degustación', 'el entrante', 'el postre de la casa'];

// Elige platos según las categorías de Yelp del restaurante
function platosDe(categorias) {
  const texto = (categorias || []).join(' ').toLowerCase();
  for (const grupo of PLATOS_POR_COCINA) {
    if (grupo.match.some((m) => texto.includes(m))) return grupo.platos;
  }
  return PLATOS_GENERICOS;
}

function generarComentarioFalso(restaurante) {
  const ciudad = restaurante.ciudad || 'la ciudad';
  const nombre = restaurante.nombre || 'este sitio';
  const platos = platosDe(restaurante.categorias);
  const plantilla = faker.helpers.arrayElement(PLANTILLAS_COMENTARIOS);
  let texto = plantilla
    .replace('{adj}', faker.helpers.arrayElement(ADJETIVOS_POS))
    .replace('{adj_neg}', faker.helpers.arrayElement(ADJETIVOS_NEG))
    .replace('{servicio}', faker.helpers.arrayElement(SERVICIOS))
    .replace('{ambiente}', faker.helpers.arrayElement(AMBIENTES))
    .replace('{plato}', faker.helpers.arrayElement(platos))
    .replace('{compania}', faker.helpers.arrayElement(COMPANIAS))
    .replace('{ciudad}', ciudad)
    .replace('{nombre}', Math.random() < 0.6 ? nombre : 'este sitio')
    .replace('{detalle}', faker.lorem.sentence())
    .replace('{valoracion}', faker.helpers.arrayElement(['buena', 'muy buena', 'excelente']));
  if (Math.random() > 0.4) texto += ' ' + faker.lorem.sentence();
  return texto;
}

function generarPuntuacionRealista(ratingYelp) {
  const base = Number(ratingYelp) || 3.5;
  const r = Math.random();
  const offset = r < 0.6
    ? faker.number.int({ min: -1, max: 1 })
    : faker.number.int({ min: -2, max: 2 });
  return Math.min(5, Math.max(1, Math.round(base + offset)));
}

function generarResenasParaRestaurante(restaurante, total = NUM_REVIEWS_POR_RESTAURANTE) {
  const resenas = [];
  for (let i = 0; i < total; i++) {
    resenas.push({
      usuario: faker.internet.username(),
      fecha: faker.date.past({ years: 2 }).toISOString().split('T')[0],
      comentario: generarComentarioFalso(restaurante),
      puntuacion: generarPuntuacionRealista(restaurante.rating_yelp),
    });
  }
  return resenas;
}

// =====================================================
// 4b. IA (GEMINI): reseñas a medida con nombre, ubicación y cocina
// =====================================================
// 1 llamada por restaurante -> las 50 de golpe. Sin API Key o si falla,
// ese restaurante cae automáticamente a Faker (nunca se queda vacío).
function promptResenasIA(r) {
  const cocina = (r.categorias || []).join(', ') || 'variada';
  return `Genera reseñas de restaurante realistas en español de España, variadas y creíbles.
Restaurante: "${r.nombre}" | Dirección: ${r.direccion_completa || r.ciudad} | Cocina: ${cocina} | Precio: ${r.precio || 'medio'} | Nota media Yelp: ${r.rating_yelp}/5.
Devuelve EXACTAMENTE ${NUM_REVIEWS_POR_RESTAURANTE} reseñas como array JSON puro (sin markdown ni texto extra).
Cada elemento: {"usuario": "nombre de usuario español creíble y distinto en cada reseña", "fecha": "YYYY-MM-DD entre 2024-01-01 y 2026-09-01, repartidas en el tiempo", "comentario": "2-4 frases naturales; menciona a veces el nombre del local, platos típicos de esa cocina y la ciudad; mezcla mayoría positiva acorde a la nota, varias neutras y 1-3 críticas; prohibido lorem ipsum y prohibido repetir comentarios", "puntuacion": número 1-5 con media cercana a ${r.rating_yelp}}.
Varía longitud, tono y vocabulario entre reseñas. Solo el JSON.`;
}

async function generarResenasConIA(restaurante) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptResenasIA(restaurante) }] }],
      generationConfig: { temperature: 0.95, responseMimeType: 'application/json', maxOutputTokens: 8192 },
    }),
  });
  if (res.status === 429) {
    const e = new Error('cuota Gemini (429)');
    e.retry = true;
    throw e;
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const texto = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
    .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const arr = JSON.parse(texto);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('la IA devolvió JSON inválido');
  // Normalizar al formato {usuario, fecha, comentario, puntuacion}
  return arr.slice(0, NUM_REVIEWS_POR_RESTAURANTE).map((x) => ({
    usuario: String(x.usuario || faker.internet.username()).slice(0, 40),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(x.fecha || '') ? x.fecha : faker.date.past({ years: 2 }).toISOString().split('T')[0],
    comentario: String(x.comentario || '').slice(0, 1000) || generarComentarioFalso(restaurante),
    puntuacion: Math.min(5, Math.max(1, Math.round(Number(x.puntuacion) || 3))),
  }));
}

function resenaFakerUnica(restaurante) {
  return {
    usuario: faker.internet.username(),
    fecha: faker.date.past({ years: 2 }).toISOString().split('T')[0],
    comentario: generarComentarioFalso(restaurante),
    puntuacion: generarPuntuacionRealista(restaurante.rating_yelp),
  };
}

async function generarResenasUnRestaurante(restaurante) {
  if (REVIEW_MOTOR === 'gemini' && GEMINI_API_KEY) {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const resenas = await generarResenasConIA(restaurante);
        while (resenas.length < NUM_REVIEWS_POR_RESTAURANTE) resenas.push(resenaFakerUnica(restaurante));
        return { resenas, via: 'ia' };
      } catch (e) {
        if (e.retry && intento < 3) {
          console.log(`   ⏳ Cuota IA, reintento ${intento}/3 en ${15 * intento}s (${restaurante.nombre})...`);
          await sleep(15000 * intento);
          continue;
        }
        console.log(`   ⚠️  IA falló en "${restaurante.nombre}" (${e.message}). Uso Faker.`);
        break;
      }
    }
  }
  return { resenas: generarResenasParaRestaurante(restaurante, NUM_REVIEWS_POR_RESTAURANTE), via: 'faker' };
}

// Genera las reseñas de todos con concurrencia limitada (cuida el tier gratis)
async function generarTodasLasResenas(restaurantes) {
  let hechas = 0, conIA = 0;
  const cola = [...restaurantes];
  const nWorkers = REVIEW_MOTOR === 'gemini' && GEMINI_API_KEY ? REVIEW_CONCURRENCIA : 8;
  await Promise.all(Array.from({ length: nWorkers }, async () => {
    while (cola.length) {
      const r = cola.shift();
      const { resenas, via } = await generarResenasUnRestaurante(r);
      r.resenas = resenas;
      if (via === 'ia') conIA++;
      hechas++;
      if (hechas % 25 === 0 || hechas === restaurantes.length) {
        console.log(`   ...${hechas}/${restaurantes.length} restaurantes con reseñas`);
      }
    }
  }));
  console.log(`✍️  ${NUM_REVIEWS_POR_RESTAURANTE} reseñas por restaurante OK (IA: ${conIA}, Faker: ${restaurantes.length - conIA}).`);
}

// =====================================================
// 5. FIREBASE
// =====================================================

async function subirAFirebase(restaurantes) {
  const credPath = path.resolve(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);

  if (!fs.existsSync(credPath)) {
    console.log(`\n⚠️  No se encontró ${FIREBASE_SERVICE_ACCOUNT_PATH}.`);
    console.log('   Firebase Console > Configuración > Cuentas de servicio > Generar clave privada.');
    if (GUARDAR_BACKUP_LOCAL_SI_NO_HAY_FIREBASE) {
      const out = path.resolve(__dirname, 'restaurantes_con_resenas.json');
      fs.writeFileSync(out, JSON.stringify(restaurantes, null, 2), 'utf8');
      console.log(`💾 Backup local: ${out} (${restaurantes.length} restaurantes)`);
      console.log('   Pon la clave y re-ejecuta: node index.js');
      return { modo: 'backup-local', ruta: out };
    }
    throw new Error(`Falta credencial: ${credPath}`);
  }

  if (!admin.apps.length) {
    const serviceAccount = require(credPath);
    // Sin databaseURL: Firestore usa el project_id del propio serviceAccountKey.json
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('🔥 Conectado a Firebase.');
  }

  const db = admin.firestore();

  // Colección ÚNICA 'restaurants' (el filtrado por ciudad se hace por terminal con zona_busqueda)
  // Firestore permite máx 500 escrituras por batch -> troceamos en lotes de 400
  const TAMANO_LOTE = 400;
  let subidos = 0;
  for (let i = 0; i < restaurantes.length; i += TAMANO_LOTE) {
    const trozo = restaurantes.slice(i, i + TAMANO_LOTE);
    const batch = db.batch();
    for (const r of trozo) {
      batch.set(db.collection(FIRESTORE_COLLECTION).doc(r.yelp_id), r, { merge: true });
    }
    await batch.commit();
    subidos += trozo.length;
    console.log(`   ...lote subido ${subidos}/${restaurantes.length}`);
  }
  console.log(`✅ Subidos ${subidos} a Firestore/${FIRESTORE_COLLECTION}.`);

  // Backup local siempre (útil para España con miles de restaurantes)
  try {
    const out = path.resolve(__dirname, 'restaurantes_espana_con_resenas.json');
    fs.writeFileSync(out, JSON.stringify(restaurantes, null, 2), 'utf8');
    console.log(`💾 Backup local España: ${out}`);
  } catch (e) {
    console.log('⚠️  No se pudo guardar backup local:', e.message);
  }

  // Alternativa Realtime Database:
  // await admin.database().ref('restaurants').set(restaurantes);

  return { modo: 'firestore', total: restaurantes.length };
}

// =====================================================
// 6. MAIN
// =====================================================
async function main() {
  try {
    console.log('🚀 Restaurante_Mira: Yelp -> Reseñas -> Firebase\n');
    const bruto = await fetchRestaurantesDeYelp();
    console.log(`📦 Yelp devolvió ${bruto.length} negocios.`);
    const restaurantes = bruto.map(mapearRestaurante);
    console.log('🗺️  Ejemplo mapeado:', JSON.stringify(restaurantes[0], null, 2).slice(0, 600) + '...\n');

    console.log(`✍️  Generando ${NUM_REVIEWS_POR_RESTAURANTE} reseñas por restaurante (motor: ${REVIEW_MOTOR})...`);
    await generarTodasLasResenas(restaurantes);
    console.log('   Ej. reseña:', JSON.stringify(restaurantes[0]?.resenas[0]) + '\n');

    await subirAFirebase(restaurantes);
    console.log('\n🎉 Fin correcto.');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { fetchRestaurantesDeYelp, mapearRestaurante, generarResenasParaRestaurante, generarTodasLasResenas, generarResenasConIA, subirAFirebase, CIUDADES };

/*
 * COMANDOS (Windows, siempre npm.cmd):
 * npm.cmd init -y
 * npm.cmd install firebase-admin @faker-js/faker
 * node index.js
 *
 * RESEÑAS CON IA (Gemini, clave gratis en https://aistudio.google.com/apikey):
 * $env:REVIEW_MOTOR="gemini"; $env:GEMINI_API_KEY="tu_clave"; node index.js
 * Prueba barata con 1 ciudad: $env:SOLO_CIUDAD="lleida"; $env:REVIEW_MOTOR="gemini"; $env:GEMINI_API_KEY="tu_clave"; node index.js
 */
