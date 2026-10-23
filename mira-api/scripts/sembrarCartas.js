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

async function sembrarCartas(db, { dryRun = false, produccion = false, lote = 100, alPlanificar = () => {} } = {}) {
  if (produccion && !dryRun) throw new Error("Producción solo permite --produccion --dry-run");
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
        const carta = generarCarta({ ...doc.data(), id: doc.id });
        await alPlanificar({ restauranteId: doc.id, nombre: doc.data().nombre || '',
          categorias: carta.categorias.length, platos: carta.categorias.reduce((n, c) => n + c.platos.length, 0) });
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

function opciones(args, entorno = process.env) {
  let project, dryRun = false, produccion = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--produccion") produccion = true;
    else if (args[i] === "--project" && args[i + 1]) project = args[++i];
    else throw new Error(`Opción no admitida: ${args[i]}`);
  }
  if (produccion) {
    if (!dryRun) throw new Error("Producción solo permite --produccion --dry-run");
    if (entorno.FIRESTORE_EMULATOR_HOST) throw new Error("No combines --produccion con FIRESTORE_EMULATOR_HOST");
    if (project !== "restaurante-mira-18e0c") throw new Error("Producción requiere --project restaurante-mira-18e0c explícito");
    return { project, dryRun, produccion };
  }
  // La escritura sigue limitada al emulador local y proyectos demo.
  if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(entorno.FIRESTORE_EMULATOR_HOST || "")) throw new Error("Se requiere FIRESTORE_EMULATOR_HOST en localhost");
  if (!/^demo-[a-z0-9-]+$/.test(project || "")) throw new Error("Indica --project demo-... para el emulador");
  return { project, dryRun };
}
async function main(args, { entorno = process.env, admin, escribir = console.log } = {}) {
  const opts = opciones(args, entorno);
  const firebase = admin || require("firebase-admin");
  const app = firebase.initializeApp({ projectId: opts.project }, opts.produccion ? "planificar-cartas-produccion" : "sembrar-cartas-local");
  try {
    const resumen = await sembrarCartas(app.firestore(), { ...opts,
      alPlanificar: opts.produccion ? carta => escribir(JSON.stringify({ accion: "crearia", ...carta })) : undefined });
    escribir(JSON.stringify({ project: opts.project, dryRun: opts.dryRun, ...(opts.produccion ? { produccion: true } : {}), ...resumen }));
  }
  finally { await app.delete(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { generarCarta, sembrarCartas, opciones, main };
