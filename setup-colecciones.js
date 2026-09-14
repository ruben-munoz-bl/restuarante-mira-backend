/**
 * setup-colecciones.js - Crea `resenas` y `reservas` y despliega sus permisos
 * --------------------------------------------------------------------------------
 * 1. Crea las colecciones con un doc marcador `_init` (Firestore las crea al
 *    primer write; el marcador es invisible para la app porque no tiene
 *    uid/estado y se puede borrar cuando haya datos reales).
 * 2. Despliega las reglas de Firestore vía Management API (sin pegar en consola).
 * 3. Opcional: da rol admin -> node setup-colecciones.js --admin UID_DE_TU_USUARIO
 *
 * Uso: node setup-colecciones.js [--admin UID]
 * Coste: 2-3 escrituras. Las reglas son gratis.
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

const CRED_PATH = './serviceAccountKey.json';

const REGLAS = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() { return request.auth != null; }
    function isOwner(uid) { return isSignedIn() && request.auth.uid == uid; }
    function isAdmin() {
      return isSignedIn()
        && exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    match /restaurants/{id} {
      allow read: if true;
      // Crear: cualquier logueado con forma válida (lo usa Aprobar del admin).
      allow create: if isSignedIn()
        && request.resource.data.nombre is string
        && request.resource.data.nombre.size() > 0
        && request.resource.data.ciudad is string
        && request.resource.data.precio in ['€','€€','€€€'];
      allow update, delete: if false;
    }
    // Perfiles: cada uno solo el suyo.
    match /usuarios/{uid} {
      allow read, write: if isSignedIn() && request.auth.uid == uid;
    }
    // Propuestas de empresa: crear logueado validado, leer dueño o admin,
    // cambiar estado solo admin.
    match /negocios/{id} {
      allow read: if isOwner(resource.data.uid) || isAdmin();
      allow create: if isSignedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.nombre is string
        && request.resource.data.nombre.size() > 0
        && request.resource.data.estado == 'pendiente';
      allow update: if isAdmin();
      allow delete: if false;
    }
    match /contactos/{id} {
      allow read: if isOwner(resource.data.uid) || isAdmin();
      allow create: if request.resource.data.mensaje is string
        && request.resource.data.mensaje.size() > 0
        && request.resource.data.mensaje.size() <= 2000;
      allow update: if isAdmin();
      allow delete: if false;
    }
    match /reservas/{id} {
      allow read: if isOwner(resource.data.uid) || isAdmin();
      allow create: if isSignedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.hora in ['13:00','14:00','15:00','20:00','21:00','22:00']
        && request.resource.data.comensales >= 1
        && request.resource.data.comensales <= 10
        && request.resource.data.estado == 'activa';
      allow update: if (isOwner(resource.data.uid) || isAdmin())
        && request.resource.data.estado == 'cancelada';
      allow delete: if false;
    }
    match /aforo/{id} {
      allow read: if true;
      allow create, update: if isSignedIn()
        && request.resource.data.ocupadas >= 0
        && request.resource.data.limite >= 4
        && request.resource.data.limite <= 12;
      allow delete: if false;
    }
    match /resenas/{id} {
      allow read: if true;
      allow create: if isSignedIn()
        && request.resource.data.usuarioId == request.auth.uid;
      allow update: if isSignedIn();
      allow delete: if false;
    }
    // Mensajería interna: los escribe el servidor (Admin SDK); el dueño
    // solo lee los suyos y marca leído (solo cambia el campo leido).
    match /mensajes/{id} {
      allow read: if isOwner(resource.data.uid);
      allow create: if false;
      allow update: if isOwner(resource.data.uid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['leido']);
      allow delete: if false;
    }
    match /admins/{uid} {
      allow read: if isSignedIn() && request.auth.uid == uid;
      allow write: if false;
    }
  }
}
`;

async function apiRest(url, token, metodo = 'GET', cuerpo = null) {
  const res = await fetch(url, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* respuesta no JSON */
  }
  if (!res.ok) {
    const detalle = json?.error?.message || texto.slice(0, 300);
    const viol = (json?.error?.details || []).map((d) => JSON.stringify(d).slice(0, 300)).join(' | ');
    const e = new Error(`${metodo} ${res.status}: ${detalle}${viol ? ` [${viol}]` : ''}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function desplegarReglas(projectId, credFile) {
  const auth = new GoogleAuth({
    keyFile: credFile,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const cliente = await auth.getClient();
  const { token } = await cliente.getAccessToken();
  if (!token) throw new Error('No se pudo obtener token OAuth2.');
  const base = `https://firebaserules.googleapis.com/v1/projects/${projectId}`;
  const releaseName = `projects/${projectId}/releases/cloud.firestore`; // nombre recurso, NO url

  // 1. Crear ruleset con el contenido
  const ruleset = await apiRest(`${base}/rulesets`, token, 'POST', {
    source: { files: [{ name: 'firestore.rules', content: REGLAS }] },
  });
  // 2. Apuntar el release de Firestore al nuevo ruleset.
  // OJO: el PATCH no recibe un Release directo sino un UpdateReleaseRequest
  // { release: {...}, updateMask: 'ruleset_name' } (ver discovery de la API).
  // Con reintentos: la API a veces rechaza con 400 transitorio justo tras crear.
  let ultimoError = null;
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const cuerpoPatch = {
        release: { name: releaseName, rulesetName: ruleset.name },
        updateMask: 'ruleset_name',
      };
      await apiRest(`${base}/releases/cloud.firestore`, token, 'PATCH', cuerpoPatch);
      ultimoError = null;
      break;
    } catch (e) {
      ultimoError = e;
      console.log(`   ⏳ PATCH intento ${intento}/4 falló (${e.message}). Reintentando en 15s...`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  if (ultimoError) throw ultimoError;
  // 3. Verificar
  const release = await apiRest(`${base}/releases/cloud.firestore`, token);
  const apunta = release.rulesetName || release.ruleset_name;
  if (apunta !== ruleset.name) {
    throw new Error('El release no apunta al ruleset nuevo. Revisa la consola.');
  }
  return ruleset.name;
}

async function main() {
  const ai = process.argv.indexOf('--admin');
  const adminUid = ai !== -1 ? process.argv[ai + 1] : null;
  if (ai !== -1 && !adminUid) throw new Error('Uso: node setup-colecciones.js --admin UID_DE_TU_USUARIO');

  const credFile = path.resolve(__dirname, CRED_PATH);
  if (!fs.existsSync(credFile)) throw new Error(`No existe ${CRED_PATH}`);
  const credenciales = require(credFile);
  const projectId = credenciales.project_id;
  console.log(`🔧 Setup en proyecto: ${projectId}\n`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(credenciales) });
  }
  const db = admin.firestore();

  // 1. Crear colecciones (marcador invisible para la app)
  for (const col of ['resenas', 'reservas']) {
    await db.collection(col).doc('_init').set({
      _init: true,
      nota: 'Marcador de setup MIRA: se puede borrar cuando haya datos reales.',
      creado: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Colección '${col}' creada (doc _init).`);
  }

  // 2. Admin opcional
  if (adminUid) {
    await db.collection('admins').doc(adminUid).set({ rol: 'admin' }, { merge: true });
    console.log(`✅ '${adminUid}' ahora es admin.`);
  } else {
    console.log('ℹ️  Sin --admin: nadie es admin todavía (re-ejecuta con --admin UID para darte acceso).');
  }

  // 3. Desplegar reglas
  try {
    const ruleset = await desplegarReglas(projectId, credFile);
    console.log(`✅ Reglas desplegadas (${ruleset}).`);
  } catch (e) {
    console.log(`⚠️  No se pudieron desplegar las reglas solas (${e.message}).`);
    console.log('   Alternativa: pega el bloque REGLAS de este archivo en Firestore → Reglas.');
    console.log('   Las colecciones SÍ quedaron creadas.');
  }

  // 4. Verificación barata (counts)
  const cols = await db.listCollections();
  console.log('\n📚 Colecciones:', cols.map((c) => c.id).sort().join(' | '));
  for (const nombre of ['resenas', 'reservas']) {
    const n = (await db.collection(nombre).count().get()).data().count;
    console.log(`   - ${nombre}: ${n} docs`);
  }
  console.log('\n🎉 Setup completo.');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
