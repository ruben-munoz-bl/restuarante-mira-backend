/**
 * rellenar-imagenes.js - Pone foto Pexels a los que no traen de Yelp
 * -------------------------------------------------------------------
 * Lee el backup local (0 lecturas Firestore), rellena imagen_url según cocina
 * y actualiza backup + Firestore (solo el campo imagen_url de cada uno).
 *
 * Necesita: $env:PEXELS_API_KEY="tu_clave" (gratis, 200 req/hora: https://www.pexels.com/api/)
 * Uso normal:  $env:PEXELS_API_KEY="..."; node rellenar-imagenes.js
 * Re-hacer las genéricas: $env:PEXELS_API_KEY="..."; $env:REPARAR="defaults"; node rellenar-imagenes.js
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { rellenarImagenPexels, consultaFotoPexels } = require('./index.js');

const BACKUP_PATH = './restaurantes_espana_con_resenas.json';
const CRED_PATH = './serviceAccountKey.json';

// Detección de las que cayeron en query genérica con el mapeo ANTIGUO
// (solo categorías, sin nombre ni tildes). Sirve para repararlas.
const MAPEO_VIEJO = ['sushi', 'japon', 'italian', 'pizza', 'pasta', 'tapas', 'spanish', 'espa', 'mediterr', 'catalan', 'mexican', 'taco', 'chinese', 'china', 'wok', 'canton', 'asian', 'indian', 'curry', 'burger', 'hamburg', 'seafood', 'marisc', 'steak', 'grill', 'parrilla', 'barbecue', 'french', 'franc', 'greek', 'grieg', 'kebab', 'turk', 'leban', 'arab', 'thai', 'vietnam', 'dessert', 'postre', 'helad', 'pastel', 'bakery', 'cake', 'ice cream', 'breakfast', 'brunch', 'caf', 'wine', 'vino'];
function fueGenericaVieja(r) {
  const t = (r.categorias || []).join(' ').toLowerCase();
  return !MAPEO_VIEJO.some((m) => t.includes(m));
}

async function main() {
  if (!process.env.PEXELS_API_KEY) {
    throw new Error('Falta $env:PEXELS_API_KEY (gratis en https://www.pexels.com/api/)');
  }
  const backupFile = path.resolve(__dirname, BACKUP_PATH);
  const arr = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

  // Modo reparación: solo las pexels que salieron genéricas con el mapeo viejo.
  // Se re-hacen con el mapeo nuevo (nombre + tildes) aunque ya tengan foto.
  const reparar = process.env.REPARAR === 'defaults';
  const pendientes = reparar
    ? arr.filter((r) => r.imagen_fuente === 'pexels' && fueGenericaVieja(r))
    : arr.filter((r) => !r.imagen_url);
  console.log(reparar ? `♻️  Genéricas a re-hacer: ${pendientes.length}` : `📷 Sin foto: ${pendientes.length}/${arr.length}`);
  if (!pendientes.length) return console.log('✅ Nada que hacer.');
  if (reparar) {
    // Avance: a qué query nueva cae cada una
    const qs = {};
    pendientes.forEach((r) => { const q = consultaFotoPexels(r); qs[q] = (qs[q] || 0) + 1; });
    console.log('   Nuevas queries:', JSON.stringify(qs));
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(require(path.resolve(__dirname, CRED_PATH))),
    });
    console.log('🔥 Conectado a Firebase.');
  }
  const db = admin.firestore();

  let ok = 0;
  for (const r of pendientes) {
    try {
      if (await rellenarImagenPexels(r, reparar)) {
        await db.collection('restaurants').doc(r.yelp_id).update({
          imagen_url: r.imagen_url,
          imagen_fuente: 'pexels',
        });
        ok++;
      }
    } catch (e) {
      console.log(`   ⚠️  ${r.nombre}: ${e.message}`);
      break;
    }
    if (ok % 25 === 0 && ok > 0) console.log(`   ...${ok}/${pendientes.length}`);
    await new Promise((res) => setTimeout(res, 400));
  }
  fs.writeFileSync(backupFile, JSON.stringify(arr, null, 2), 'utf8');
  console.log(`✅ ${ok}/${pendientes.length} con foto. Backup actualizado.`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
