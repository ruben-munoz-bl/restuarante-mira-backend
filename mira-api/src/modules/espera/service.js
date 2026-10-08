/**
 * Lista de espera por franja (restaurante + fecha + hora).
 *
 * - Un documento por persona y franja: `espera/{rest}_{fecha}_{hora}_{uid}`
 *   (id fijo: apuntarse dos veces no duplica y no hace falta consultar).
 * - Cuando se libera una mesa (cancelación), se avisa al primero de la cola y
 *   se le RETIENE la plaza 30 min en el documento de aforo (`retenidas`), que
 *   crearReserva ya lee: retener no cuesta lecturas extra al reservar.
 * - Si no reserva a tiempo, la retención caduca y se avisa al siguiente.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { SLOTS } = require("../../config/constants");
const { enviarMensaje } = require("../mensajes/notificar");

const RETENCION_MS = 30 * 60000;

const claveFranja = (restId, fecha, hora) => `${restId}_${fecha}_${hora}`;
/** Firestore devuelve Timestamp; los tests, Date o texto ISO. */
const aMs = (v) => (v?.toMillis ? v.toMillis() : v?.toDate ? v.toDate().getTime() : new Date(v).getTime());
/** Copia del documento sin `id` (Firestore no admite campos undefined ni queremos guardar el id dentro). */
const sinId = ({ id, ...resto }) => resto;
const idEspera = (restId, fecha, hora, uid) => `${claveFranja(restId, fecha, hora)}_${uid}`;
const aforoId = (restId, fecha, hora) => `${restId}_${fecha}_${hora}`;

/** Retenciones todavía vigentes de un documento de aforo. */
function retencionesVigentes(aforo, ahora = Date.now()) {
  return Object.fromEntries(Object.entries(aforo?.retenidas || {}).filter(([, hasta]) => Number(hasta) > ahora));
}

/** Plazas libres para `uid`: las retenidas para otros cuentan como ocupadas; la suya, no. */
function libresPara(aforo, limite, uid, ahora = Date.now()) {
  const ret = retencionesVigentes(aforo, ahora);
  const ajenas = Object.keys(ret).filter((u) => u !== uid).length;
  const ocupadas = Number(aforo?.ocupadas) || 0;
  return { libres: Math.max(0, limite - ocupadas - ajenas), retenidaParaTi: Boolean(uid && ret[uid]), retenidaHasta: uid && ret[uid] ? Number(ret[uid]) : null };
}

function franjaFutura(fecha, hora, ahora = new Date()) {
  const t = new Date(`${fecha}T${hora}:00+02:00`).getTime(); // hora de Cataluña (aprox. UTC+2; basta para "¿ya pasó?")
  return Number.isFinite(t) && t > ahora.getTime();
}

function errorCodigo(mensaje, code, status = 400) {
  const e = new Error(mensaje);
  e.code = code;
  e.status = status;
  return e;
}

async function unirse({ uid, nombre, restauranteId, fecha, hora, comensales }, { restaurante, limite }) {
  if (!SLOTS.includes(hora)) throw errorCodigo("Hora no válida", "VALIDATION_ERROR");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !franjaFutura(fecha, hora)) throw errorCodigo("Esa franja ya ha pasado", "VALIDATION_ERROR");
  const n = Number(comensales);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw errorCodigo("Comensales: 1-10", "VALIDATION_ERROR");

  const aforoSnap = await db.collection("aforo").doc(aforoId(restauranteId, fecha, hora)).get();
  const disp = libresPara(aforoSnap.exists ? aforoSnap.data() : {}, limite, uid);
  if (disp.libres > 0) throw errorCodigo("Hay mesa libre en esa franja: puedes reservar directamente.", "HAY_SITIO", 409);

  const ref = db.collection("espera").doc(idEspera(restauranteId, fecha, hora, uid));
  const previo = await ref.get();
  if (previo.exists && ["esperando", "avisado"].includes(previo.data().estado)) {
    return { id: ref.id, ...previo.data(), yaEstabas: true };
  }
  const doc = {
    uid,
    nombre: nombre || "",
    clave: claveFranja(restauranteId, fecha, hora),
    restauranteId,
    nombreRestaurante: restaurante?.nombre || "",
    fecha,
    hora,
    comensales: n,
    estado: "esperando",
    creado: new Date(),
  };
  await ref.set(doc);
  logger.info({ uid, clave: doc.clave }, "Apuntado a lista de espera");
  return { id: ref.id, ...doc };
}

async function listarMias(uid) {
  const snap = await db.collection("espera").where("uid", "==", uid).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((e) => ["esperando", "avisado"].includes(e.estado) && franjaFutura(e.fecha, e.hora))
    .sort((a, b) => `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`));
}

async function salir(id, uid) {
  const ref = db.collection("espera").doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) throw errorCodigo("No encontrado", "NOT_FOUND", 404);
  const e = snap.data();
  await ref.set({ ...e, estado: "cancelado", actualizado: new Date() });
  // Si tenía la plaza retenida, se libera para el siguiente.
  if (e.estado === "avisado") await liberarRetencion(e.restauranteId, e.fecha, e.hora, uid);
  return { ok: true };
}

async function liberarRetencion(restId, fecha, hora, uid) {
  const aforoRef = db.collection("aforo").doc(aforoId(restId, fecha, hora));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(aforoRef);
    if (!snap.exists) return;
    const data = snap.data();
    const ret = { ...(data.retenidas || {}) };
    if (!(uid in ret)) return;
    delete ret[uid];
    tx.set(aforoRef, { ...data, retenidas: ret });
  });
  await alLiberarseMesa(restId, fecha, hora);
}

/**
 * Se ha liberado una mesa en la franja: si hay cola, retiene la plaza al primero
 * y le avisa. Devuelve el uid avisado o null. Nunca lanza (lo llaman las cancelaciones).
 */
async function alLiberarseMesa(restId, fecha, hora, { limite = null } = {}) {
  try {
    if (!franjaFutura(fecha, hora)) return null;
    const snap = await db.collection("espera").where("clave", "==", claveFranja(restId, fecha, hora)).get();
    const cola = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((e) => e.estado === "esperando")
      .sort((a, b) => aMs(a.creado) - aMs(b.creado));
    if (!cola.length) return null;
    const primero = cola[0];
    const hasta = Date.now() + RETENCION_MS;

    const aforoRef = db.collection("aforo").doc(aforoId(restId, fecha, hora));
    const avisado = await db.runTransaction(async (tx) => {
      const aforoSnap = await tx.get(aforoRef);
      const data = aforoSnap.exists ? aforoSnap.data() : { ocupadas: 0 };
      const lim = limite ?? (Number(data.limite) || 0);
      const vigentes = retencionesVigentes(data);
      if (lim && (Number(data.ocupadas) || 0) + Object.keys(vigentes).length >= lim) return false; // no hay hueco real
      tx.set(aforoRef, { ...data, retenidas: { ...vigentes, [primero.uid]: hasta } });
      tx.set(db.collection("espera").doc(primero.id), { ...sinId(primero), estado: "avisado", avisadoEn: new Date(), expiraEn: new Date(hasta) });
      return true;
    });
    if (!avisado) return null;

    await enviarMensaje(primero.uid, {
      tipo: "lista_espera",
      titulo: `¡Mesa libre en ${primero.nombreRestaurante || "el restaurante"}!`,
      cuerpo: `Se ha liberado una mesa el ${primero.fecha} a las ${primero.hora}. Te la guardamos 30 minutos: resérvala antes de que pase al siguiente de la lista.`,
      enlace: `#/r/${encodeURIComponent(restId)}?fecha=${primero.fecha}&hora=${encodeURIComponent(primero.hora)}&comensales=${primero.comensales}`,
      enlaceTexto: "Reservar ahora",
      extra: { restaurantId: restId },
    });
    logger.info({ uid: primero.uid, restId, fecha, hora }, "Lista de espera: aviso de mesa libre");
    return primero.uid;
  } catch (err) {
    logger.warn({ restId, fecha, hora, err: err.message }, "Lista de espera: no se pudo avisar");
    return null;
  }
}

/** Retención usada: quien reserva estando avisado pasa a "confirmado" (lo llama crearReserva dentro de su transacción). */
function marcarConfirmadoTx(tx, restId, fecha, hora, uid, previo) {
  tx.set(db.collection("espera").doc(idEspera(restId, fecha, hora, uid)), { ...sinId(previo || {}), estado: "confirmado", actualizado: new Date() }, { merge: true });
}

/** Caduca las retenciones vencidas y avisa al siguiente. Lo llama el cron (pocas lecturas: solo los "avisado"). */
async function caducarAvisos(ahora = Date.now()) {
  const snap = await db.collection("espera").where("estado", "==", "avisado").get();
  let n = 0;
  for (const d of snap.docs) {
    const e = d.data();
    if (aMs(e.expiraEn) > ahora) continue;
    await db.collection("espera").doc(d.id).set({ ...e, estado: "expirado", actualizado: new Date(ahora) });
    await liberarRetencion(e.restauranteId, e.fecha, e.hora, e.uid);
    n++;
  }
  return n;
}

module.exports = {
  aMs, RETENCION_MS, claveFranja, idEspera, retencionesVigentes, libresPara, franjaFutura,
  unirse, listarMias, salir, alLiberarseMesa, marcarConfirmadoTx, caducarAvisos,
};
