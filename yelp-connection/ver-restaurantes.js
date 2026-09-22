/**
 * ver-restaurantes.js - Ver / filtrar restaurantes por terminal (colección única 'restaurants')
 * ------------------------------------------------------------------------------------------------
 * Uso:
 *   node ver-restaurantes.js                    -> muestra el primero que encuentre
 *   node ver-restaurantes.js --list             -> lista 20 (id + nombre + ciudad)
 *   node ver-restaurantes.js --zona tarragona   -> lista 20 de esa zona (zona_busqueda/ciudad)
 *   node ver-restaurantes.js --zonas            -> cuenta cuántos hay por zona
 *   node ver-restaurantes.js --nombre <texto>   -> lista hasta 20 cuyo nombre contenga el texto
 *   node ver-restaurantes.js <yelp_id>          -> busca por ID exacto (1 sola lectura)
 *   node ver-restaurantes.js <texto>            -> atajo: ID exacto y si no, 1º por nombre
 *   node ver-restaurantes.js --random           -> muestra uno al azar
 *   node ver-restaurantes.js --random --zona vigo -> uno al azar de esa zona
 *
 * Coste: --list/--random 20-50 lecturas; --zonas/--nombre hasta ~690 (full-scan).
 * Lo más barato para 1 local es el ID exacto.
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const FIREBASE_SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
const FIRESTORE_COLLECTION = 'restaurants';
const MAX_LISTA = 20;

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

function pintarLinea(d) {
  console.log(` - ${d.id} | ${d.data().nombre} (${d.data().ciudad}) [${d.data().zona_busqueda}]`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = args[0];
  // flag --zona <texto>: filtra por zona_busqueda o ciudad (ej: --zona tarragona)
  const zi = args.indexOf('--zona');
  const zonaFiltro = zi !== -1 ? (args[zi + 1] || '').toLowerCase() : null;
  if (zi !== -1 && !args[zi + 1]) return console.log('Uso: node ver-restaurantes.js --zona tarragona');
  // flag --nombre <texto>: lista coincidencias por nombre (ej: --nombre botin)
  const ni = args.indexOf('--nombre');
  const nombreFiltro = ni !== -1 ? (args[ni + 1] || '').toLowerCase() : null;
  if (ni !== -1 && !args[ni + 1]) return console.log('Uso: node ver-restaurantes.js --nombre botin');

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

  // --zonas: conteo por zona_busqueda (full-scan, ~690 lecturas)
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

  // --nombre: lista coincidencias por nombre (+ zona opcional)
  if (nombreFiltro) {
    const snap = await col.limit(500).get();
    const docs = snap.docs
      .filter((d) => (d.data().nombre || '').toLowerCase().includes(nombreFiltro))
      .filter(enZona)
      .slice(0, MAX_LISTA);
    if (!docs.length) return console.log(`❌ Nada con nombre "${args[ni + 1]}". Prueba: node ver-restaurantes.js --list`);
    console.log(`📋 ${docs.length} con nombre "${args[ni + 1]}"${zonaFiltro ? ` en zona "${zonaFiltro}"` : ''}:`);
    docs.forEach(pintarLinea);
    return process.exit(0);
  }

  // --list: solo ids para copiar/pegar (con filtro de zona opcional)
  if (arg === '--list' || (arg === '--zona')) {
    const snap = await col.limit(zonaFiltro ? 500 : 20).get();
    const docs = snap.docs.filter(enZona).slice(0, MAX_LISTA);
    if (!docs.length) return console.log(`⚠️ Nada en zona "${zonaFiltro || ''}". Prueba: node ver-restaurantes.js --zonas`);
    console.log(`📋 ${docs.length}${zonaFiltro ? ` en zona "${zonaFiltro}"` : ' (primeros)' }: `);
    docs.forEach(pintarLinea);
    return process.exit(0);
  }

  // --random (con o sin zona)
  if (arg === '--random' || !arg) {
    if (arg === '--random' || zonaFiltro) {
      const snap = await col.limit(zonaFiltro ? 500 : 50).get();
      const docs = snap.docs.filter(enZona);
      if (!docs.length) return console.log(`⚠️ Nada en zona "${zonaFiltro}". Prueba: node ver-restaurantes.js --zonas`);
      const pick = docs[Math.floor(Math.random() * docs.length)];
      pintar(pick.data(), pick.id);
    } else {
      const snap = await col.limit(1).get();
      if (snap.empty) return console.log('⚠️ Colección vacía. Ejecuta: node index.js');
      pintar(snap.docs[0].data(), snap.docs[0].id);
    }
    return process.exit(0);
  }

  // 1) intento por ID exacto (1 sola lectura, lo más barato)
  const porId = await col.doc(arg).get();
  if (porId.exists) {
    pintar(porId.data(), porId.id);
    return process.exit(0);
  }

  // 2) atajo por nombre: enseña el primero que contenga el texto
  const snap = await col.limit(200).get();
  const q = arg.toLowerCase();
  const hall = snap.docs.find((d) => (d.data().nombre || '').toLowerCase().includes(q));
  if (hall) {
    pintar(hall.data(), hall.id);
  } else {
    console.log(`❌ Nada para "${arg}". Prueba: node ver-restaurantes.js --list`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
