/**
 * ver-usuarios.js - Ver / filtrar usuarios de Firebase Authentication por terminal
 * --------------------------------------------------------------------------------
 * Uso:
 *   node ver-usuarios.js --list            -> lista hasta 50 (email + nombre + alta)
 *   node ver-usuarios.js --todos           -> cuenta el total (paginado)
 *   node ver-usuarios.js --email <texto>   -> filtra por email (contiene, ej: --email gmail)
 *   node ver-usuarios.js --nombre <texto>  -> filtra por nombre visible (contiene)
 *   node ver-usuarios.js --uid <uid>       -> ficha de 1 usuario por UID exacto
 *
 * Cuesta 0 lecturas de Firestore: Auth no toca la BBDD.
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const FIREBASE_SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';
const MAX_LISTA = 50;

function pintar(u) {
  const alta = u.metadata?.creationTime
    ? new Date(u.metadata.creationTime).toLocaleDateString('es-ES')
    : '—';
  const estado = u.disabled ? '🚫 deshabilitado' : '✅ activo';
  console.log(` - ${u.email || '(sin email)'} | ${u.displayName || '(sin nombre)'} | alta ${alta} | ${estado}`);
  console.log(`   uid: ${u.uid}`);
}

function coincide(u, emailFiltro, nombreFiltro) {
  if (emailFiltro && !(u.email || '').toLowerCase().includes(emailFiltro)) return false;
  if (nombreFiltro && !(u.displayName || '').toLowerCase().includes(nombreFiltro)) return false;
  return true;
}

async function todosLosUsuarios(auth, tope = 5000) {
  const todos = [];
  let pageToken;
  do {
    const r = await auth.listUsers(1000, pageToken);
    todos.push(...r.users);
    pageToken = r.pageToken;
    if (todos.length >= tope) break;
  } while (pageToken);
  return todos;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = args[0];
  const ei = args.indexOf('--email');
  const emailFiltro = ei !== -1 ? (args[ei + 1] || '').toLowerCase() : null;
  if (ei !== -1 && !args[ei + 1]) return console.log('Uso: node ver-usuarios.js --email gmail');
  const ni = args.indexOf('--nombre');
  const nombreFiltro = ni !== -1 ? (args[ni + 1] || '').toLowerCase() : null;
  if (ni !== -1 && !args[ni + 1]) return console.log('Uso: node ver-usuarios.js --nombre maria');
  const ui = args.indexOf('--uid');
  const uid = ui !== -1 ? args[ui + 1] : null;
  if (ui !== -1 && !uid) return console.log('Uso: node ver-usuarios.js --uid abc123');

  const credPath = path.resolve(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
  if (!fs.existsSync(credPath)) throw new Error(`No existe ${FIREBASE_SERVICE_ACCOUNT_PATH}`);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require(credPath)) });
  }
  const auth = admin.auth();

  // --uid: 1 usuario exacto
  if (uid) {
    try {
      pintar(await auth.getUser(uid));
    } catch {
      console.log(`❌ No existe el uid "${uid}".`);
    }
    return process.exit(0);
  }

  const todos = await todosLosUsuarios(auth);
  if (!todos.length) return console.log('⚠️ Aún no hay usuarios. Crea uno en la web (#/registro).');

  // --todos: solo el total
  if (arg === '--todos') {
    console.log(`👥 Total usuarios: ${todos.length}`);
    return process.exit(0);
  }

  // --list / filtros: lista hasta 50
  const filtrados = todos.filter((u) => coincide(u, emailFiltro, nombreFiltro)).slice(0, MAX_LISTA);
  if (!filtrados.length) return console.log('❌ Sin coincidencias. Prueba: node ver-usuarios.js --list');
  const extra = emailFiltro ? ` con email "${args[ei + 1]}"` : nombreFiltro ? ` con nombre "${args[ni + 1]}"` : '';
  console.log(`👥 ${filtrados.length}${extra} (de ${todos.length}):`);
  filtrados.forEach(pintar);
  if (todos.length > MAX_LISTA && !emailFiltro && !nombreFiltro) {
    console.log(`... y ${todos.length - MAX_LISTA} más. Filtra con --email o --nombre.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
