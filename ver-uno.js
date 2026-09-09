/**
 * ver-uno.js - Ver / filtrar restaurantes por terminal (colección única 'restaurants')
 * ----------------------------------------------------------------------------------
 * Uso:
 *   node ver-uno.js                      -> muestra el primero que encuentre
 *   node ver-uno.js --list               -> lista 20 (id + nombre + ciudad)
 *   node ver-uno.js --zona tarragona     -> lista 20 de esa zona (filtra por zona_busqueda/ciudad)
 *   node ver-uno.js --zonas              -> cuenta cuántos hay por zona
 *   node ver-uno.js <yelp_id>            -> busca por ID exacto
 *   node ver-uno.js <texto>              -> busca por nombre (ej: node ver-uno.js miracle)
 *   node ver-uno.js --random             -> muestra uno al azar
 *   node ver-uno.js --random --zona vigo -> uno al azar de esa zona
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const FIREBASE_SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
const FIRESTORE_COLLECTION = 'restaurants';

function pintar(r, id) {
  console.log('\n========================================');
  console.log(`🍽️  ${r.nombre}  [${id}]`);
  console.log(`📍 ${r.direccion_completa || r.direccion || ''} (${r.ciudad || ''})`);
  console.log(`⭐ Yelp: ${r.rating_yelp} (${r.total_resenas_yelp} reseñas) | 💰 ${r.precio || '-'}`);
  console.log(`🏷️  ${(r.categorias || []).join(', ')}`);
  console.log(`📌 ${r.coordenadas?.latitud}, ${r.coordenadas?.longitud}`);
  console.log(`💬 Sintéticas: ${(r.resenas || []).length}`);
  (r.resenas || []).slice(0, 3).forEach((x, i) => {
    console.log(`   ${i + 1}. [${x.puntuacion}/5] ${x.usuario} (${x.fecha}): ${x.comentario.slice(0, 120)}...`);
  });
  if ((r.resenas || []).length > 3) console.log(`   ... y ${(r.resenas.length - 3)} más`);
  console.log('========================================\n');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = args[0];
  // flag --zona <texto>: filtra por zona_busqueda o ciudad (ej: --zona tarragona)
  const zi = args.indexOf('--zona');
  const zonaFiltro = zi !== -1 ? (args[zi + 1] || '').toLowerCase() : null;
  if (zi !== -1 && !args[zi + 1]) return console.log('Uso: node ver-uno.js --zona tarragona');

  const credPath = path.resolve(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
  if (!fs.existsSync(credPath)) throw new Error(`No existe ${FIREBASE_SERVICE_ACCOUNT_PATH}`);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require(credPath)) });
  }
  const col = admin.firestore().collection(FIRESTORE_COLLECTION);
  const enZona = (d) => {
    if (!zonaFiltro) return true;
    const r = d.data();
    return ((r.zona_busqueda || '') + ' ' + (r.ciudad || '')).toLowerCase().includes(zonaFiltro);
  };

  // --zonas: conteo por zona_busqueda (lee solo esos 2 campos)
  if (arg === '--zonas') {
    const snap = await col.select('zona_busqueda').get();
    if (snap.empty) return console.log('⚠️ Colección vacía. Ejecuta: node index.js');
    const conteo = {};
    snap.forEach((d) => { const z = d.data().zona_busqueda || '(sin zona)'; conteo[z] = (conteo[z] || 0) + 1; });
    console.log('📊 Por zona:');
    for (const [z, n] of Object.entries(conteo).sort((a, b) => b[1] - a[1])) console.log(` - ${z}: ${n}`);
    console.log(`TOTAL: ${snap.size}`);
    return process.exit(0);
  }

  // --list: solo ids para copiar/pegar (con filtro de zona opcional)
  if (arg === '--list' || (arg === '--zona')) {
    const snap = await col.limit(zonaFiltro ? 500 : 20).get();
    const docs = snap.docs.filter(enZona).slice(0, 20);
    if (!docs.length) return console.log(`⚠️ Nada en zona "${zonaFiltro || ''}". Prueba: node ver-uno.js --zonas`);
    console.log(`📋 ${docs.length}${zonaFiltro ? ` en zona "${zonaFiltro}"` : ' (primeros)' }: `);
    docs.forEach((d) => console.log(` - ${d.id} | ${d.data().nombre} (${d.data().ciudad}) [${d.data().zona_busqueda}]`));
    return process.exit(0);
  }

  // --random (con o sin zona)
  if (arg === '--random' || !arg) {
    if (arg === '--random' || zonaFiltro) {
      const snap = await col.limit(zonaFiltro ? 500 : 50).get();
      const docs = snap.docs.filter(enZona);
      if (!docs.length) return console.log(`⚠️ Nada en zona "${zonaFiltro}". Prueba: node ver-uno.js --zonas`);
      const pick = docs[Math.floor(Math.random() * docs.length)];
      pintar(pick.data(), pick.id);
    } else {
      const snap = await col.limit(1).get();
      if (snap.empty) return console.log('⚠️ Colección vacía. Ejecuta: node index.js');
      pintar(snap.docs[0].data(), snap.docs[0].id);
    }
    return process.exit(0);
  }

  // 1) intento por ID exacto (más rápido)
  const porId = await col.doc(arg).get();
  if (porId.exists) {
    pintar(porId.data(), porId.id);
    return process.exit(0);
  }

  // 2) búsqueda por nombre (contiene, insensible a mayúsculas)
  const snap = await col.limit(200).get();
  const q = arg.toLowerCase();
  const hall = snap.docs.find((d) => (d.data().nombre || '').toLowerCase().includes(q));
  if (hall) {
    pintar(hall.data(), hall.id);
  } else {
    console.log(`❌ Nada para "${arg}". Prueba: node ver-uno.js --list`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
