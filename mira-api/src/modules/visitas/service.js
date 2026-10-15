const { createHash } = require("crypto");
const { db, admin } = require("../../middlewares/verifyFirebaseAuth");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const { env } = require("../../config/env");
const ofertas = require("../ofertas/service");
const { distanciaM, coordenadasDe, vigente, hoyMadrid } = require("../ofertas/logica");
const { DURACION_MS, RADIO_LLEGADA, error, comprobarSecreto, firmarQr, leerQr, estadoVisita } = require("./logica");

const visitas = () => db.collection("visitas");
const pendienteRef = (uid, restauranteId) => db.collection("visitas_pendientes").doc(
  createHash("sha256").update(JSON.stringify([uid, restauranteId])).digest("hex"),
);

// Lista explícita: nunca devolver uid, fecha interna ni datos del bloqueo.
function vista(id, d, ahora = Date.now()) {
  return {
    id, restauranteId: d.restauranteId, ofertaId: d.ofertaId,
    nivel: { distancia: d.nivel.distancia, texto: d.nivel.texto, descuentoPct: d.nivel.descuentoPct },
    estado: estadoVisita(d, ahora), creada: d.creada, caducaEn: d.caducaEn,
    confirmadaEn: d.confirmadaEn ?? null, comisionPct: d.comisionPct ?? null,
  };
}

function nombreDe(perfil) {
  const nombre = perfil.exists ? perfil.data().nombre : null;
  return typeof nombre === "string" ? nombre : "";
}

function contar(tx, restauranteId, fecha, campo) {
  tx.set(db.collection("ofertas_stats").doc(`${restauranteId}_${fecha}`), {
    restauranteId, fecha, [campo]: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
}

async function crear(uid, { restauranteId, lat, lng }) {
  comprobarSecreto(env.VISITAS_SECRET);
  const [publica] = await ofertas.publicas(restauranteId);
  if (!publica) throw error(404, "NOT_FOUND", "Restaurante sin oferta vigente");
  const nuevaRef = visitas().doc();
  const bloqueo = pendienteRef(uid, restauranteId);
  const visita = await db.runTransaction(async tx => {
    const restSnap = await tx.get(db.collection("restaurants").doc(restauranteId));
    const ofertaSnap = await tx.get(db.collection("ofertas").doc(publica.id));
    if (!restSnap.exists || !ofertaSnap.exists || ofertaSnap.data().restauranteId !== restauranteId || !vigente(ofertaSnap.data())) {
      throw error(404, "NOT_FOUND", "Restaurante sin oferta vigente");
    }
    const restaurante = restSnap.data();
    const coords = coordenadasDe(restaurante);
    if (!coords || restaurante.coordenadas.latitud == null || restaurante.coordenadas.longitud == null
      || restaurante.coordenadas.latitud === "" || restaurante.coordenadas.longitud === "") {
      throw error(404, "NOT_FOUND", "Restaurante sin coordenadas");
    }
    const distancia = distanciaM({ lat, lng }, coords);
    if (!Number.isFinite(distancia) || distancia > RADIO_LLEGADA) {
      throw Object.assign(error(422, "LEJOS", "Estás fuera del radio de llegada"), { distanciaM: Math.round(distancia) });
    }
    const nivel = ofertaSnap.data().niveles.find(n => n.distancia === 20);
    if (!nivel) throw error(404, "NOT_FOUND", "Oferta sin nivel de llegada");
    const lock = await tx.get(bloqueo);
    const anteriorRef = lock.exists ? visitas().doc(lock.data().visitaId) : null;
    const anterior = anteriorRef ? await tx.get(anteriorRef) : null;
    const ahora = Date.now();
    if (anterior?.exists && anterior.data().uid === uid && anterior.data().restauranteId === restauranteId) {
      const d = anterior.data();
      if (estadoVisita(d, ahora) === "pendiente") return vista(anterior.id, d, ahora);
      if (d.estado === "pendiente") tx.update(anteriorRef, { estado: "caducada" });
    }
    const fecha = hoyMadrid(new Date(ahora));
    const datos = {
      uid, restauranteId, ofertaId: publica.id, nivel: { ...nivel }, estado: "pendiente", fecha,
      creada: new Date(ahora).toISOString(), caducaEn: new Date(ahora + DURACION_MS).toISOString(),
      confirmadaEn: null, comisionPct: null,
    };
    tx.set(nuevaRef, datos);
    tx.set(bloqueo, { visitaId: nuevaRef.id });
    contar(tx, restauranteId, fecha, "visitas");
    return vista(nuevaRef.id, datos, ahora);
  });
  // Reemitir no amplía la caducidad original. Con ID/fecha iguales el texto es idéntico.
  return { visita, qr: firmarQr(visita.id, Date.parse(visita.caducaEn), env.VISITAS_SECRET) };
}

async function obtener(id, uid) {
  const snap = await visitas().doc(id).get();
  if (!snap.exists) throw error(404, "NOT_FOUND", "Visita no encontrada");
  if (snap.data().uid !== uid) throw error(403, "FORBIDDEN", "No tienes permiso sobre esta visita");
  return vista(snap.id, snap.data());
}

async function validar(qr, user) {
  const { visitaId, caducaEnMs } = leerQr(qr, env.VISITAS_SECRET);
  if (Date.now() >= caducaEnMs) throw error(410, "QR_CADUCADO", "QR caducado");
  const ref = visitas().doc(visitaId);
  const previa = await ref.get();
  if (!previa.exists) throw error(404, "NOT_FOUND", "Visita no encontrada");
  try {
    await comprobarRestaurante(previa.data().restauranteId, user);
  } catch (err) {
    if (err.status === 403) throw error(403, "OTRO_RESTAURANTE", "El QR pertenece a otro restaurante");
    throw err;
  }
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const ahora = Date.now();
    if (ahora >= caducaEnMs) throw error(410, "QR_CADUCADO", "QR caducado");
    if (!snap.exists) throw error(404, "NOT_FOUND", "Visita no encontrada");
    const d = snap.data();
    if (Date.parse(d.caducaEn) !== caducaEnMs) throw error(400, "QR_INVALIDO", "QR inválido");
    if (d.estado !== "pendiente") throw error(409, "QR_USADO", "El QR ya no está pendiente");
    const restSnap = await tx.get(db.collection("restaurants").doc(d.restauranteId));
    if (!restSnap.exists) throw error(404, "NOT_FOUND", "Restaurante no encontrado");
    const perfil = await tx.get(db.collection("usuarios").doc(d.uid));
    const bloqueo = pendienteRef(d.uid, d.restauranteId);
    const lock = await tx.get(bloqueo);
    const comisionPct = Number(restSnap.data().comisionPct ?? env.COMISION_PCT);
    const cambios = { estado: "confirmada", confirmadaEn: new Date(ahora).toISOString(), comisionPct };
    tx.update(ref, cambios);
    if (lock.exists && lock.data().visitaId === visitaId) tx.delete(bloqueo);
    contar(tx, d.restauranteId, hoyMadrid(new Date(ahora)), "confirmadas");
    return {
      visita: vista(visitaId, { ...d, ...cambios }, ahora),
      aplicar: { texto: d.nivel.texto, descuentoPct: d.nivel.descuentoPct },
      cliente: { nombre: nombreDe(perfil) },
    };
  });
}

async function delRestaurante(restauranteId, fecha = hoyMadrid()) {
  const snap = await visitas().where("restauranteId", "==", restauranteId).where("fecha", "==", fecha).orderBy("creada", "desc").get();
  const nombres = new Map();
  await Promise.all([...new Set(snap.docs.map(doc => doc.data().uid))].map(async uid => {
    const perfil = await db.collection("usuarios").doc(uid).get();
    nombres.set(uid, nombreDe(perfil));
  }));
  return snap.docs.map(doc => ({ ...vista(doc.id, doc.data()), cliente: { nombre: nombres.get(doc.data().uid) } }));
}

module.exports = { crear, obtener, validar, delRestaurante };
