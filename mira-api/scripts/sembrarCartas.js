#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { cartaLibro } = require("./lib/cartaSimulada");
const { cartaSchema } = require("../src/modules/cartas/logica");

function generarCarta(restaurante, ahora = new Date()) {
  const id = texto => createHash("sha256").update(texto).digest("hex").slice(0, 32);
  const categorias = cartaLibro(restaurante).secciones.map(s => ({
    id: `cat_${id(s.titulo)}`, nombre: s.titulo,
    platos: s.platos.map(p => ({ id: `pl_${id(`${restaurante.id}:${p.nombre}`)}`,
      nombre: p.nombre, descripcion: p.descripcion, precio: Math.round(p.precio * 100) / 100,
      foto: null, alergenos: p.alergenos, disponible: true })),
  }));
  const validada = cartaSchema.parse({ categorias });
  return { restauranteId: restaurante.id, ...validada, actualizada: ahora.toISOString() };
}

async function sembrarCartas(db, { dryRun = false, lote = 100 } = {}) {
  if (!Number.isInteger(lote) || lote < 1 || lote > 500) throw new Error("Lote inválido");
  const resumen = { leidos: 0, tecnicos: 0, existentes: 0, planificadas: 0, creadas: 0 };
  let ultimo;
  while (true) {
    let query = db.collection("restaurants").orderBy("__name__").limit(lote);
    if (ultimo) query = query.startAfter(ultimo);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      resumen.leidos++;
      if (doc.id === "_catalogo" || doc.data()._tipo === "catalogo") { resumen.tecnicos++; continue; }
      const cartaRef = db.collection("cartas").doc(doc.id);
      if (dryRun) {
        if ((await cartaRef.get()).exists) { resumen.existentes++; continue; }
        generarCarta({ ...doc.data(), id: doc.id });
        resumen.planificadas++;
      } else {
        // El editor puede crear una carta durante el recorrido: comprobar de
        // nuevo dentro de la transacción evita sobrescribirla en esa carrera.
        const resultado = await db.runTransaction(async tx => {
          const existente = await tx.get(cartaRef);
          if (existente.exists) return "existentes";
          const actual = await tx.get(db.collection("restaurants").doc(doc.id));
          if (!actual.exists) return null;
          const carta = generarCarta({ ...actual.data(), id: doc.id });
          tx.set(cartaRef, carta);
          return "creadas";
        });
        if (resultado) resumen[resultado]++;
      }
    }
    ultimo = snap.docs[snap.docs.length - 1];
    if (snap.size < lote) break;
  }
  return resumen;
}

const PROYECTO_PRODUCCION = "restaurante-mira-18e0c";

function opciones(args, entorno = process.env) {
  let project, dryRun = false, produccion = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--produccion") produccion = true;
    else if (args[i] === "--project" && args[i + 1]) project = args[++i];
    else throw new Error(`Opción no admitida: ${args[i]}`);
  }
  // Producción solo con opción explícita, el proyecto exacto y credencial de servicio (OK de Izan, M14).
  if (produccion) {
    if (entorno.FIRESTORE_EMULATOR_HOST) throw new Error("--produccion no se usa con el emulador");
    if (project !== PROYECTO_PRODUCCION) throw new Error(`--produccion exige --project ${PROYECTO_PRODUCCION}`);
    if (!entorno.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("--produccion exige GOOGLE_APPLICATION_CREDENTIALS");
    return { project, dryRun, produccion };
  }
  // Esta entrega solo permite el emulador local y proyectos demo. Sin vía
  // accidental a producción, aunque existan credenciales en el entorno.
  if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(entorno.FIRESTORE_EMULATOR_HOST || "")) throw new Error("Se requiere FIRESTORE_EMULATOR_HOST en localhost");
  if (!/^demo-[a-z0-9-]+$/.test(project || "")) throw new Error("Indica --project demo-... para el emulador");
  return { project, dryRun, produccion };
}
async function main(args) {
  const opts = opciones(args);
  const admin = require("firebase-admin");
  const app = admin.initializeApp(
    opts.produccion ? { projectId: opts.project, credential: admin.credential.applicationDefault() } : { projectId: opts.project },
    "sembrar-cartas-local",
  );
  try { console.log(JSON.stringify({ project: opts.project, dryRun: opts.dryRun, ...await sembrarCartas(app.firestore(), opts) })); }
  finally { await app.delete(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { generarCarta, sembrarCartas, opciones };
