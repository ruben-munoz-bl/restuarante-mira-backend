/**
 * Simula actividad (reservas, tickets, ingresos y comisiones) en un restaurante
 * para enseñar el panel de empresa. Todo lo creado lleva `seed: SEED_TAG`, así
 * que se puede borrar sin tocar datos reales.
 *
 *   node scripts/seed-demo-restaurante.js                     # siembra en "Ari's Restaurant"
 *   node scripts/seed-demo-restaurante.js --nombre "Otro"     # otro restaurante
 *   node scripts/seed-demo-restaurante.js --borrar            # deshace la simulación
 *
 * Credenciales: las mismas que la API (serviceAccountKey.json o GOOGLE_APPLICATION_CREDENTIALS).
 */
const { db } = require("../src/middlewares/verifyFirebaseAuth");
const { SLOTS, calcularPrecioBase } = require("../src/config/constants");

const SEED_TAG = "demo-ari";
const DIAS_PASADOS = 120;
const DIAS_FUTUROS = 21;

const args = process.argv.slice(2);
const borrar = args.includes("--borrar");
const nombreIdx = args.indexOf("--nombre");
const NOMBRE = nombreIdx >= 0 ? args[nombreIdx + 1] : "Ari's Restaurant";

const CLIENTES = [
  "Lucía Martín", "Pablo Romero", "Carmen Ruiz", "Javier Gómez", "Marta Sánchez",
  "Sergio López", "Elena Navarro", "Daniel Torres", "Paula Díaz", "Álvaro Moreno",
  "Laura Gil", "Hugo Serrano", "Irene Castro", "Mario Ortega", "Nerea Vidal",
  "Adrián Molina", "Sara Delgado", "Raúl Herrera", "Claudia Prieto", "Iván Ramos",
];

// PRNG con semilla: la simulación sale igual cada vez que se ejecuta.
let semilla = 20261009;
const rnd = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const r2 = (n) => Math.round(n * 100) / 100;

async function buscarRestaurante() {
  const snap = await db.collection("restaurants").where("nombre", "==", NOMBRE).limit(1).get();
  if (snap.empty) throw new Error(`No existe ningún restaurante con nombre "${NOMBRE}"`);
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function commitEnLotes(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

async function deshacer(rest) {
  const [res, tic] = await Promise.all([
    db.collection("reservas").where("seed", "==", SEED_TAG).get(),
    db.collection("tickets").where("seed", "==", SEED_TAG).get(),
  ]);
  const ops = [...res.docs, ...tic.docs].map((d) => (b) => b.delete(d.ref));

  // Aforo de las reservas futuras que sumamos.
  const aforo = {};
  res.docs.forEach((d) => {
    const r = d.data();
    if (r.estado === "cancelada") return;
    const k = `${r.restaurantId}_${r.fecha}_${r.hora}`;
    aforo[k] = (aforo[k] || 0) + 1;
  });
  for (const [k, n] of Object.entries(aforo)) {
    const ref = db.collection("aforo").doc(k);
    const s = await ref.get();
    if (s.exists) ops.push((b) => b.update(ref, { ocupadas: Math.max(0, (Number(s.data().ocupadas) || 0) - n) }));
  }

  // Resta de finanzas lo que sumó la simulación.
  const finRef = db.collection("finanzas_restaurante").doc(rest.id);
  const fin = await finRef.get();
  if (fin.exists && fin.data().seedDemo) {
    const f = fin.data();
    const s = f.seedDemo;
    ops.push((b) => b.set(finRef, {
      ingresosBrutos: r2((f.ingresosBrutos || 0) - s.ingresosBrutos),
      comisiones: r2((f.comisiones || 0) - s.comisiones),
      neto: r2((f.neto || 0) - s.neto),
      totalTickets: (f.totalTickets || 0) - s.totalTickets,
      comensalesAtendidos: (f.comensalesAtendidos || 0) - s.comensalesAtendidos,
      baseImponible: r2((f.baseImponible || 0) - s.baseImponible),
      seedDemo: null,
      updatedAt: new Date(),
    }, { merge: true }));
  }
  await commitEnLotes(ops);
  console.log(`Borradas ${res.size} reservas y ${tic.size} tickets simulados de "${rest.nombre}".`);
}

async function sembrar(rest) {
  const previas = await db.collection("reservas").where("seed", "==", SEED_TAG).limit(1).get();
  if (!previas.empty) throw new Error("Ya hay una simulación sembrada. Ejecuta antes con --borrar.");

  const comisionPct = rest.comisionPct || 8;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const ops = [];
  const aforo = {};
  const acum = { ingresosBrutos: 0, comisiones: 0, neto: 0, totalTickets: 0, comensalesAtendidos: 0, baseImponible: 0 };
  let nRes = 0;

  for (let off = -DIAS_PASADOS; off <= DIAS_FUTUROS; off++) {
    const dia = new Date(hoy.getTime() + off * 86400000);
    const finde = [5, 6, 0].includes(dia.getDay());
    // Crecimiento suave: el local va ganando clientela con los meses.
    const tendencia = 1 + (DIAS_PASADOS + Math.min(off, 0)) / DIAS_PASADOS * 0.8;
    const base = (finde ? 6 : 3) * tendencia * (off > 0 ? Math.max(0.15, 1 - off / DIAS_FUTUROS) : 1);
    const n = Math.max(0, Math.round(base + (rnd() - 0.5) * 3));

    for (let i = 0; i < n; i++) {
      const fecha = iso(dia);
      const hora = pick(SLOTS);
      const comensales = Math.min(10, 1 + Math.floor(rnd() * 4) + (rnd() < 0.15 ? 3 : 0));
      const cliente = pick(CLIENTES);
      const email = `${cliente.split(" ")[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()}.demo@mira.test`;
      const createdAt = new Date(dia.getTime() - Math.floor(rnd() * 10 + 1) * 86400000 + rnd() * 86400000);

      let estado;
      const x = rnd();
      if (off < 0) estado = x < 0.8 ? "completada" : x < 0.92 ? "cancelada" : "no_show";
      else if (off === 0) estado = x < 0.85 ? "confirmada" : "cancelada";
      else estado = x < 0.55 ? "confirmada" : x < 0.93 ? "pendiente" : "cancelada";

      const resRef = db.collection("reservas").doc();
      const reserva = {
        uid: `demo-${email}`,
        email,
        restaurantId: rest.id,
        restauranteId: rest.id,
        nombreRestaurante: rest.nombre,
        usuarioNombre: cliente,
        usuarioEmail: email,
        ciudad: rest.ciudad || "",
        zona: rest.zona_busqueda || rest.zona || "",
        fecha,
        hora,
        comensales,
        comentarios: rnd() < 0.15 ? pick(["Terraza si es posible", "Cumpleaños", "Alergia al marisco", "Con carrito de bebé"]) : "",
        estado,
        codigo: `MIRA-${resRef.id.slice(0, 6).toUpperCase()}`,
        ticketId: null,
        puntosGenerados: estado === "completada" ? 100 : 0,
        multiplicadorAplicado: 1,
        seed: SEED_TAG,
        createdAt,
        updatedAt: createdAt,
      };

      if (estado === "completada") {
        // Gasto realista por mesa alrededor del precio medio del local.
        const precioBase = r2(calcularPrecioBase(rest, comensales) * comensales / 2 * (0.8 + rnd() * 0.5));
        const comision = r2(precioBase * comisionPct / 100);
        const neto = r2(precioBase - comision);
        const ticketRef = db.collection("tickets").doc();
        const ticketAt = new Date(`${fecha}T${hora}:00`);
        ticketAt.setHours(ticketAt.getHours() + 2);
        ops.push((b) => b.set(ticketRef, {
          reservaId: resRef.id,
          uid: reserva.uid,
          restaurantId: rest.id,
          nombreRestaurante: rest.nombre,
          restauranteNombre: rest.nombre,
          clienteNombre: cliente,
          clienteUid: reserva.uid,
          fecha,
          precioBase,
          descuentoAplicado: 0,
          totalPagado: precioBase,
          puntosCanjeados: 0,
          comisionPct,
          importeComision: comision,
          netoRestaurante: neto,
          comensales,
          asistio: true,
          tipoDocumento: "Ticket TPV",
          estado: "emitido",
          emitidoPor: "simulacion",
          seed: SEED_TAG,
          createdAt: ticketAt,
        }));
        Object.assign(reserva, { ticketId: ticketRef.id, totalPagado: precioBase, importeComision: comision, netoRestaurante: neto, asistio: true });
        acum.ingresosBrutos += precioBase;
        acum.comisiones += comision;
        acum.neto += neto;
        acum.totalTickets += 1;
        acum.comensalesAtendidos += comensales;
        acum.baseImponible += r2(precioBase / 1.1);
      }

      if (off >= 0 && estado !== "cancelada") {
        const k = `${rest.id}_${fecha}_${hora}`;
        aforo[k] = (aforo[k] || 0) + 1;
      }
      ops.push((b) => b.set(resRef, reserva));
      nRes++;
    }
  }

  for (const [k, n] of Object.entries(aforo)) {
    const ref = db.collection("aforo").doc(k);
    const s = await ref.get();
    ops.push((b) => b.set(ref, { ocupadas: (s.exists ? Number(s.data().ocupadas) || 0 : 0) + n }, { merge: true }));
  }

  Object.keys(acum).forEach((k) => (acum[k] = r2(acum[k])));
  const finRef = db.collection("finanzas_restaurante").doc(rest.id);
  const fin = (await finRef.get()).data() || {};
  ops.push((b) => b.set(finRef, {
    restaurantId: rest.id,
    ingresosBrutos: r2((fin.ingresosBrutos || 0) + acum.ingresosBrutos),
    comisiones: r2((fin.comisiones || 0) + acum.comisiones),
    neto: r2((fin.neto || 0) + acum.neto),
    totalTickets: (fin.totalTickets || 0) + acum.totalTickets,
    comensalesAtendidos: (fin.comensalesAtendidos || 0) + acum.comensalesAtendidos,
    baseImponible: r2((fin.baseImponible || 0) + acum.baseImponible),
    seedDemo: acum,
    createdAt: fin.createdAt || new Date(),
    updatedAt: new Date(),
  }, { merge: true }));

  await commitEnLotes(ops);
  console.log(`"${rest.nombre}" (${rest.id}): ${nRes} reservas, ${acum.totalTickets} tickets`);
  console.log(`Facturación ${acum.ingresosBrutos} € · comisiones MIRA ${acum.comisiones} € · neto ${acum.neto} €`);
}

(async () => {
  const rest = await buscarRestaurante();
  await (borrar ? deshacer(rest) : sembrar(rest));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
