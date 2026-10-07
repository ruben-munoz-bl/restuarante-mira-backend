/**
 * simular-auditoria.js — escribe en `auditoria` la actividad de 100 usuarios
 * simulados (y 3 admins) repartida en los últimos 30 días.
 *
 * Usa el MISMO generador y validador que la API (mira-api/src/modules/auditoria),
 * así el script y el botón "Simular 100 usuarios" del panel producen lo mismo.
 * Todo va con fuente:'sim' y un simRunId nuevo; se deshace con `npm run borrar-simulacion`.
 *
 * Uso: node simular-auditoria.js [usuarios=100] [dias=30]
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { generarSimulacion, escribirEnLotes } = require('../mira-api/src/modules/auditoria/simulador');

const CRED = path.resolve(__dirname, './serviceAccountKey.json');

async function main() {
  if (!fs.existsSync(CRED)) throw new Error('Falta serviceAccountKey.json en yelp-connection/ (no se sube al repo)');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(CRED)) });
  const db = admin.firestore();

  const usuarios = Number(process.argv[2]) || 100;
  const dias = Number(process.argv[3]) || 30;
  const simRunId = `sim-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  const { eventos, resumen } = generarSimulacion({ simRunId, usuarios, dias });

  console.log(`Simulación ${simRunId}: ${eventos.length} eventos de ${usuarios} usuarios en ${dias} días`);
  await escribirEnLotes(db, 'auditoria', eventos, (n, total) => process.stdout.write(`\r  escritos ${n}/${total}`));
  process.stdout.write('\n');

  // Subir la revisión hace que la API recargue su copia y vea los eventos retroactivos.
  const ref = db.collection('auditoria_estado').doc('global');
  const actual = (await ref.get()).data() || {};
  await ref.set({
    ...actual,
    versionEsquema: 1,
    revision: (actual.revision || 0) + 1,
    simRunId,
    sim: { simRunId, estado: 'completada', escritos: eventos.length, total: eventos.length, fin: new Date(), resumen, via: 'script' },
    actualizadoEn: new Date(),
  });

  const reales = (await db.collection('auditoria').where('fuente', '==', 'real').count().get()).data().count;
  console.log('Resumen:');
  console.table({ ...resumen, reales_en_bd: reales, simulados_esta_ejecucion: eventos.length });
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
