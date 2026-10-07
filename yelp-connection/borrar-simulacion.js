/**
 * borrar-simulacion.js — borra de `auditoria` SOLO los documentos fuente:'sim'.
 * Los eventos reales no se tocan nunca (el filtro es por fuente en la consulta
 * y se vuelve a comprobar documento a documento antes de borrar).
 *
 * Uso: node borrar-simulacion.js            → todas las simulaciones
 *      node borrar-simulacion.js <simRunId> → solo esa ejecución
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const CRED = path.resolve(__dirname, './serviceAccountKey.json');

async function main() {
  if (!fs.existsSync(CRED)) throw new Error('Falta serviceAccountKey.json en yelp-connection/');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(CRED)) });
  const db = admin.firestore();
  const simRunId = process.argv[2] || null;

  let q = db.collection('auditoria').where('fuente', '==', 'sim');
  if (simRunId) q = q.where('simRunId', '==', simRunId);
  const snap = await q.get();
  const docs = snap.docs.filter((d) => d.data().fuente === 'sim');
  for (let i = 0; i < docs.length; i += 500) {
    const lote = db.batch();
    docs.slice(i, i + 500).forEach((d) => lote.delete(d.ref));
    await lote.commit();
    process.stdout.write(`\r  borrados ${Math.min(i + 500, docs.length)}/${docs.length}`);
  }
  process.stdout.write('\n');

  const ref = db.collection('auditoria_estado').doc('global');
  const actual = (await ref.get()).data() || {};
  await ref.set({ ...actual, revision: (actual.revision || 0) + 1, simRunId: null, sim: { estado: 'limpiada', borrados: docs.length, fin: new Date(), via: 'script' }, actualizadoEn: new Date() });
  console.log(`Borrados ${docs.length} eventos simulados${simRunId ? ` de ${simRunId}` : ''}. Los reales siguen intactos.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
