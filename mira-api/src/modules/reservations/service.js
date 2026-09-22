const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { SLOTS, generarCodigo, hoyISO, PUNTOS_RESERVA_BASE, MULTIPLICADOR_RACHA } = require("../../config/constants");
const { addMovement } = require("../points/service");
const { generarTicket } = require("../tickets/service");

const LIMITE_REPETIDA_DIA = 3;

async function crearReserva({ uid, restaurantId, restauranteId, fecha, hora, comensales, comentarios }) {
  const restId = restaurantId || restauranteId;
  if (!SLOTS.includes(hora)) throw new Error("Hora no válida");
  const n = parseInt(comensales, 10);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("Comensales: 1-10");

  const userSnap = await db.collection("usuarios").doc(uid).get();
  if (!userSnap.exists) throw new Error("Usuario no encontrado");

  const hoyCount = await db.collection("reservas")
    .where("uid", "==", uid)
    .where("fecha", "==", fecha)
    .where("estado", "in", ["confirmada", "completada"])
    .get();
  if (hoyCount.size >= LIMITE_REPETIDA_DIA) throw new Error("Máximo 3 reservas por día");

  const result = await db.runTransaction(async (tx) => {
    const restSnap = await tx.get(db.collection("restaurants").doc(restId));
    if (!restSnap.exists) throw new Error("Restaurante no encontrado");
    const restaurante = restSnap.data();

    const limite = restaurante.maxReservasPorHora || 6;
    const aforoId = `${restId}_${fecha}_${hora}`;
    const aforoRef = db.collection("aforo").doc(aforoId);
    const aforoSnap = await tx.get(aforoRef);
    const ocupadas = aforoSnap.exists ? (aforoSnap.data().ocupadas || 0) : 0;
    if (ocupadas >= limite) throw new Error("Completo a esa hora");

    const codigo = generarCodigo();
    const nuevaRef = db.collection("reservas").doc();
    tx.set(nuevaRef, {
      uid,
      email: userSnap.data().email,
      restaurantId: restId,
      nombreRestaurante: restaurante.nombre || "",
      ciudad: restaurante.ciudad || "",
      zona: restaurante.zona || "",
      fecha,
      hora,
      comensales: n,
      comentarios: (comentarios || "").trim(),
      estado: "confirmada",
      codigo,
      ticketId: null,
      puntosGenerados: 0,
      multiplicadorAplicado: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.set(aforoRef, { ocupadas: ocupadas + 1, limite }, { merge: true });

    return { id: nuevaRef.id, codigo, restauranteNombre: restaurante.nombre };
  });

  logger.info({ uid, reservaId: result.id, restaurantId: restId, fecha, hora }, "Reservation created");
  return result;
}

async function cancelarReserva(reservaId, uid) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection("reservas").doc(reservaId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Reserva no encontrada");
    const r = snap.data();
    if (r.uid !== uid) throw new Error("No autorizado");
    if (r.estado === "cancelada") throw new Error("Ya cancelada");

    tx.update(ref, { estado: "cancelada", updatedAt: new Date() });

    const aforoRef = db.collection("aforo").doc(`${r.restaurantId}_${r.fecha}_${r.hora}`);
    const aforoSnap = await tx.get(aforoRef);
    const ocupadas = aforoSnap.exists ? (aforoSnap.data().ocupadas || 0) : 0;
    tx.set(aforoRef, { ocupadas: Math.max(0, ocupadas - 1) }, { merge: true });
  });
  logger.info({ reservaId, uid }, "Reservation cancelled");
}

async function completarReserva(reservaId, { uid, precioManual, emitidoPor } = {}) {
  const reservaRef = db.collection("reservas").doc(reservaId);
  const reservaSnap = await reservaRef.get();
  if (!reservaSnap.exists) throw new Error("Reserva no encontrada");
  const reserva = reservaSnap.data();

  if (reserva.estado === "completada") return { yaCompletada: true };

  const userSnap = await db.collection("usuarios").doc(reserva.uid).get();
  const userData = userSnap.data();

  await db.runTransaction(async (tx) => {
    tx.update(reservaRef, { estado: "completada", updatedAt: new Date() });

    const multiplicador = (userData.rachaReservas?.semanasConsecutivas || 0) >= 1 ? MULTIPLICADOR_RACHA : 1;
    const puntosBase = PUNTOS_RESERVA_BASE;
    const puntos = Math.round(puntosBase * multiplicador);

    const userRef = db.collection("usuarios").doc(reserva.uid);
    const currentSnap = await tx.get(userRef);
    const current = currentSnap.data();
    const nuevoSaldo = (current.saldoPuntos || 0) + puntos;

    tx.update(userRef, {
      saldoPuntos: nuevoSaldo,
      totalAcumulado: (current.totalAcumulado || 0) + puntos,
      updatedAt: new Date(),
    });

    const movRef = db.collection("movimientos").doc();
    tx.set(movRef, {
      uid: reserva.uid,
      tipo: "reserva",
      cantidad: puntos,
      saldoResultante: nuevoSaldo,
      referenciaTipo: "reserva",
      referenciaId: reservaId,
      createdAt: new Date(),
    });

    tx.update(reservaRef, { puntosGenerados: puntos, multiplicadorAplicado: multiplicador });
  });

  const ticket = await generarTicket(reservaId, { precioManual, emitidoPor: emitidoPor || "sistema" });

  try {
    const { onInvitadoReservaCompletada } = require("../invitations/service");
    await onInvitadoReservaCompletada(reserva.uid);
  } catch (err) {
    logger.error({ reservaId, error: err.message }, "Invitation check failed");
  }

  logger.info({ reservaId, uid: reserva.uid }, "Reservation completed");
  return { completada: true, ticket };
}

async function listarReservas(uid, { estado, page = 1, limit = 50 } = {}) {
  let query = db.collection("reservas").where("uid", "==", uid).orderBy("fecha", "desc").orderBy("hora", "desc");
  if (estado) query = query.where("estado", "==", estado);
  const snapshot = await query.limit(limit).get();
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { crearReserva, cancelarReserva, completarReserva, listarReservas };
