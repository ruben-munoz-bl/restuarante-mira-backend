/**
 * Ofertas por distancia en Firestore (colección `ofertas`). Una sola activa por
 * restaurante; la oferta no guarda nada del usuario ni de su ubicación.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { vigente, coordenadasDe, distanciaM, nivelAlcanzado, RADIO_MAX } = require("./logica");

const col = () => db.collection("ofertas");

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function vista(doc) {
  const d = doc.data();
  return {
    id: doc.id, restauranteId: d.restauranteId, titulo: d.titulo, activa: d.activa,
    desde: d.desde ?? null, hasta: d.hasta ?? null, niveles: d.niveles, creado: d.creado, actualizado: d.actualizado,
  };
}

async function delRestaurante(restauranteId) {
  const snap = await col().where("restauranteId", "==", String(restauranteId)).get();
  // Orden en memoria: un restaurante tiene pocas ofertas y así no hace falta índice compuesto.
  return snap.docs.map(vista).sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
}

/** Pública: solo la oferta activa y vigente hoy. */
async function publicas(restauranteId) {
  return (await delRestaurante(restauranteId)).filter((o) => vigente(o));
}

function campos(d) {
  return { titulo: d.titulo, activa: d.activa, desde: d.desde ?? null, hasta: d.hasta ?? null, niveles: d.niveles };
}

/**
 * «Una sola activa por restaurante» se garantiza con un documento de bloqueo
 * `ofertas_activas/{restauranteId}` = { ofertaId }, leído y escrito en la misma
 * transacción que la oferta. Firestore serializa las transacciones que tocan ese
 * documento: de dos altas o activaciones simultáneas solo una se confirma.
 */
const bloqueo = (restauranteId) => db.collection("ofertas_activas").doc(String(restauranteId));

/** Lanza 409 si el bloqueo apunta a otra oferta que sigue existiendo y activa. */
async function exigirLibre(tx, restauranteId, exceptoId) {
  const lock = await tx.get(bloqueo(restauranteId));
  const ocupadaPor = lock.exists ? lock.data().ofertaId : null;
  if (!ocupadaPor || ocupadaPor === exceptoId) return;
  const otra = await tx.get(col().doc(ocupadaPor));
  if (otra.exists && otra.data().activa) throw error(409, "CONFLICT", "Ya hay otra oferta activa en este restaurante");
}

async function crear(datos) {
  const restauranteId = String(datos.restauranteId);
  const ref = col().doc();
  const ahora = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    if (datos.activa) await exigirLibre(tx, restauranteId, null);
    tx.set(ref, { restauranteId, ...campos(datos), creado: ahora, actualizado: ahora });
    if (datos.activa) tx.set(bloqueo(restauranteId), { ofertaId: ref.id });
  });
  invalidarCache();
  return obtener(ref.id);
}

async function obtener(id) {
  const snap = await col().doc(String(id)).get();
  if (!snap.exists) throw error(404, "NOT_FOUND", "Oferta no encontrada");
  return vista(snap);
}

async function editar(id, datos) {
  const ref = col().doc(String(id));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw error(404, "NOT_FOUND", "Oferta no encontrada");
    const { restauranteId } = snap.data();
    const lock = await tx.get(bloqueo(restauranteId));
    const mia = lock.exists && lock.data().ofertaId === ref.id;
    if (datos.activa && !mia) await exigirLibre(tx, restauranteId, ref.id);
    tx.update(ref, { ...campos(datos), actualizado: new Date().toISOString() });
    if (datos.activa && !mia) tx.set(bloqueo(restauranteId), { ofertaId: ref.id });
    if (!datos.activa && mia) tx.delete(bloqueo(restauranteId));
  });
  invalidarCache();
  return obtener(id);
}

async function borrar(id) {
  const ref = col().doc(String(id));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const lock = await tx.get(bloqueo(snap.data().restauranteId));
    tx.delete(ref);
    if (lock.exists && lock.data().ofertaId === ref.id) tx.delete(bloqueo(snap.data().restauranteId));
  });
  invalidarCache();
}

/*
 * «Ofertas cerca de mí»: los candidatos son las ofertas apuntadas por
 * ofertas_activas (como mucho una por restaurante), con las coordenadas de su
 * restaurante. Se cachean 60 s porque esta ruta se llama muy a menudo; crear,
 * editar o borrar en esta instancia invalidan la caché al momento.
 */
const CACHE_MS = 60 * 1000;
// generacion sube en cada invalidación: una carga empezada antes no puede
// publicar su resultado (traería ofertas ya desactivadas o borradas). Las
// peticiones simultáneas comparten la misma carga en curso.
let cache = { generacion: 0, hasta: 0, candidatos: null, cargando: null };

function invalidarCache() {
  cache = { generacion: cache.generacion + 1, hasta: 0, candidatos: null, cargando: null };
}

async function cargarCandidatos() {
  const bloqueos = await db.collection("ofertas_activas").get();
  const lista = await Promise.all(bloqueos.docs.map(async (lock) => {
    const [ofertaSnap, restSnap] = await Promise.all([
      col().doc(String(lock.data().ofertaId)).get(),
      db.collection("restaurants").doc(lock.id).get(),
    ]);
    if (!ofertaSnap.exists || !restSnap.exists) return null;
    const coordenadas = coordenadasDe(restSnap.data());
    if (!coordenadas) return null;
    return { restaurante: { id: restSnap.id, nombre: restSnap.data().nombre || "", coordenadas }, oferta: vista(ofertaSnap) };
  }));
  return lista.filter(Boolean);
}

async function candidatos() {
  if (cache.candidatos && Date.now() < cache.hasta) return cache.candidatos;
  if (!cache.cargando) {
    const generacion = cache.generacion;
    const cargando = cargarCandidatos();
    cache.cargando = cargando;
    cargando.then((lista) => {
      if (cache.generacion === generacion) cache = { generacion, hasta: Date.now() + CACHE_MS, candidatos: lista, cargando: null };
    }, () => {
      if (cache.generacion === generacion && cache.cargando === cargando) cache.cargando = null;
    });
  }
  const generacion = cache.generacion;
  const lista = await cache.cargando;
  // Si se invalidó mientras tanto, esta carga es vieja: volver a pedir.
  return cache.generacion === generacion ? lista : candidatos();
}

/**
 * La posición solo se usa para calcular; no se guarda ni se registra. Radio,
 * nivel y orden usan la distancia real; solo se redondea el dato mostrado.
 */
async function cerca(posicion) {
  const resultado = [];
  for (const c of await candidatos()) {
    if (!vigente(c.oferta)) continue;
    const d = distanciaM(posicion, c.restaurante.coordenadas);
    if (d > RADIO_MAX) continue;
    resultado.push({ ...c, d, nivel: nivelAlcanzado(c.oferta.niveles, d) });
  }
  return resultado.sort((a, b) => a.d - b.d).map(({ d, ...r }) => ({ ...r, distanciaM: Math.round(d) }));
}

module.exports = { publicas, delRestaurante, crear, obtener, editar, borrar, cerca, invalidarCache };
