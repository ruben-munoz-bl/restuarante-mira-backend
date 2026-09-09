/**
 * borrar.js - Mini script para VACIAR la BBDD (demo para el jefe)
 * -------------------------------------------------
 * Borra TODOS los documentos de la colección única 'restaurants'.
 * Uso: node borrar.js
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

// --- CONFIG (misma que index.js) ---
const FIREBASE_SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
const FIRESTORE_COLLECTION = 'restaurants';
const TAMANO_LOTE = 400; // Firestore: máx 500 borrados por batch

async function main() {
  const credPath = path.resolve(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
  if (!fs.existsSync(credPath)) throw new Error(`No existe ${FIREBASE_SERVICE_ACCOUNT_PATH}`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require(credPath)) });
  }
  const db = admin.firestore();

  console.log(`🗑️  Vaciando Firestore/${FIRESTORE_COLLECTION}...`);
  const snap = await db.collection(FIRESTORE_COLLECTION).get();
  console.log(`   Encontrados: ${snap.size} docs`);

  if (snap.size === 0) {
    console.log('✅ Ya estaba vacía.');
    process.exit(0);
  }

  const docs = snap.docs;
  let borrados = 0;
  for (let i = 0; i < docs.length; i += TAMANO_LOTE) {
    const trozo = docs.slice(i, i + TAMANO_LOTE);
    const batch = db.batch();
    trozo.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    borrados += trozo.length;
    console.log(`   ...borrados ${borrados}/${docs.length}`);
  }

  const check = await db.collection(FIRESTORE_COLLECTION).limit(1).get();
  console.log(check.empty ? '✅ BBDD vacía. Lista para la demo: node index.js' : '⚠️  Quedan docs, re-ejecuta.');
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
