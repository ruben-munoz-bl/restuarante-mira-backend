/**
 * recordatorios.js - Avisos 24h antes en la MENSAJERÍA INTERNA de la web
 * ----------------------------------------------------------------------
 * Busca reservas activas de MAÑANA y deja a cada cliente un mensaje en la
 * colección `mensajes` (lo ve en #/mensajes con el informe del clima).
 * Sin emails ni credenciales: 1 query + 1 escritura por reserva.
 *
 * Uso:
 *   node recordatorios.js          -> escribe los avisos
 *   node recordatorios.js --dry    -> solo muestra lo que haría
 * Para automatizar a diario: Programador de tareas de Windows.
 */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { componerEmail } = require('./componerEmail.js');
const { buscarParkingsCercanos } = require('./parking.js');

const CRED_PATH = './serviceAccountKey.json';

function mananaISO() {
  const h = new Date();
  h.setDate(h.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${h.getFullYear()}-${p(h.getMonth() + 1)}-${p(h.getDate())}`;
}

async function meteoDia(lat, lng, fecha) {
  if (lat == null || lng == null) return null;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&daily=temperature_2m_max,precipitation_probability_max,weathercode` +
        `&timezone=auto&start_date=${fecha}&end_date=${fecha}`,
    );
    if (!res.ok) return null;
    const d = (await res.json()).daily || {};
    if (!d.time?.length) return null;
    const codigo = d.weathercode?.[0];
    return {
      tempMax: d.temperature_2m_max?.[0] ?? null,
      lluviaProb: d.precipitation_probability_max?.[0] ?? null,
      resumen:
        codigo === 0 ? 'Despejado' : codigo <= 3 ? 'Nubes y claros' : codigo < 50 ? 'Niebla'
        : codigo < 70 ? 'Lluvia' : codigo < 80 ? 'Nieve' : 'Chubascos o tormenta',
    };
  } catch {
    return null;
  }
}

async function main() {
  const seco = process.argv.includes('--dry');
  const manana = mananaISO();
  console.log(`📅 Reservas activas de mañana (${manana})${seco ? ' [MODO PRUEBA]' : ''}...`);

  const credFile = path.resolve(__dirname, CRED_PATH);
  if (!fs.existsSync(credFile)) throw new Error(`No existe ${CRED_PATH}`);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require(credFile)) });
  }
  const db = admin.firestore();

  // 1 query por fecha (el estado se filtra en cliente: sin índice compuesto).
  const snap = await db.collection('reservas').where('fecha', '==', manana).get();
  const mananaLista = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.estado === 'activa' && r.uid);
  console.log(`   Encontradas: ${mananaLista.length}`);
  if (!mananaLista.length) {
    console.log('✅ Nada que avisar.');
    return process.exit(0);
  }

  let ok = 0;
  for (const r of mananaLista) {
    // Coords: del doc y si es antigua (sin ellas), del restaurante (1 lectura).
    let { lat = null, lng = null } = r;
    let nombreRest = r.nombreRestaurante || 'tu restaurante';
    let direccion = '';
    let terraza = r.terraza ?? null;
    if ((lat == null || terraza == null) && r.restaurantId) {
      try {
        const s = await db.collection('restaurants').doc(String(r.restaurantId)).get();
        if (s.exists()) {
          const d = s.data();
          lat = lat ?? d.coordenadas?.latitud ?? null;
          lng = lng ?? d.coordenadas?.longitud ?? null;
          nombreRest = d.nombre || nombreRest;
          direccion = d.direccion_completa || '';
          terraza = terraza ?? d.terraza ?? null;
        }
      } catch {
        /* seguimos sin meteo */
      }
    }
    const meteo = await meteoDia(lat, lng, manana);
    // Parking más cercano (Overpass, sin clave). Si falla, el aviso sale igual.
    let parkings = [];
    try {
      parkings = await buscarParkingsCercanos(lat, lng, { radio: 800, limite: 3 });
    } catch {
      parkings = [];
    }
    const email = componerEmail(
      { nombreRestaurante: nombreRest, direccion, fecha: r.fecha, hora: r.hora, comensales: r.comensales, codigo: r.codigo, terraza },
      meteo,
      parkings,
    );
    // Evita duplicados si se ejecuta dos veces el mismo día (1 query simple).
    const ya = await db.collection('mensajes').where('reservaId', '==', r.id).get();
    if (ya.docs.some((d) => d.data().tipo === 'recordatorio')) {
      console.log(`   ⏭️  ya avisado: ${nombreRest} (${r.fecha} ${r.hora})`);
      continue;
    }
    const cuerpo = `${email.texto}`;
    if (seco) {
      const p0 = parkings[0];
      console.log(`   [DRY] para ${r.email || r.uid}: "${email.asunto}"${meteo ? ` (meteo ${meteo.tempMax}°/${meteo.lluviaProb}%)` : ' (sin meteo)'}${p0 ? ` (parking ${p0.nombre} a ${p0.distanciaM}m)` : ' (sin parking)'}`);
      continue;
    }
    const mejor = parkings[0] || null;
    await db.collection('mensajes').add({
      uid: r.uid,
      email: r.email || '',
      tipo: 'recordatorio',
      titulo: email.asunto,
      cuerpo,
      fecha: r.fecha,
      hora: r.hora,
      codigo: r.codigo || '',
      restauranteNombre: nombreRest,
      reservaId: r.id,
      leido: false,
      ...(mejor
        ? {
            parkingNombre: mejor.nombre,
            parkingDistanciaM: mejor.distanciaM,
            parkingLat: mejor.lat,
            parkingLng: mejor.lng,
            parkingLink: `https://www.google.com/maps/search/?api=1&query=${mejor.lat},${mejor.lng}`,
          }
        : {}),
      creado: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`   ✉️  aviso para ${r.email || r.uid} (${nombreRest})`);
    ok++;
  }
  console.log(seco ? '✅ Prueba OK (no se escribió nada).' : `✅ Avisos escritos: ${ok}/${mananaLista.length}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
