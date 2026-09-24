const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { SLOTS, PUNTOS_RESERVA_BASE, MULTIPLICADOR_RACHA } = require("../../config/constants");

function limitePorResenas(totalResenasYelp) {
  const n = Number(totalResenasYelp) || 0;
  if (n < 100) return 4;
  if (n < 500) return 6;
  if (n < 1000) return 8;
  if (n < 2000) return 10;
  return 12;
}

function limiteDelLocal(restaurante) {
  const propio = Number(restaurante?.maxReservasPorHora);
  if (Number.isInteger(propio) && propio > 0) return propio;
  return limitePorResenas(restaurante?.totalResenasYelp ?? restaurante?.total_resenas_yelp);
}

function aforoId(restaurantId, fecha, hora) {
  return `${restaurantId}_${fecha}_${hora}`;
}

function generarCodigo() {
  return `MIRA-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function notFoundError() {
  const err = new Error("Restaurante no encontrado");
  err.status = 404;
  err.code = "NOT_FOUND";
  return err;
}

async function getDisponibilidad(restaurantId, fecha, hora) {
  const restSnap = await db.collection("restaurants").doc(restaurantId).get();
  if (!restSnap.exists) throw notFoundError();
  const restaurante = restSnap.data();
  const limite = limiteDelLocal(restaurante);
  if (!fecha || !hora) return { limite, ocupadas: 0, libres: limite };
  const snap = await db.collection("aforo").doc(aforoId(restaurantId, fecha, hora)).get();
  const ocupadas = snap.exists ? Number(snap.data().ocupadas) || 0 : 0;
  return { limite, ocupadas, libres: Math.max(0, limite - ocupadas) };
}

async function crearReserva({ uid, restaurantId, restauranteId, fecha, hora, comensales, comentarios, usuario }) {
  const restId = restaurantId || restauranteId;
  if (!SLOTS.includes(hora)) throw new Error("Hora no válida");
  const n = Number(comensales);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("Comensales: 1-10");

  const result = await db.runTransaction(async (tx) => {
    const restSnap = await tx.get(db.collection("restaurants").doc(restId));
    if (!restSnap.exists) throw notFoundError();
    const restaurante = restSnap.data();

    const limite = limiteDelLocal(restaurante);
    const aforoRef = db.collection("aforo").doc(aforoId(restId, fecha, hora));
    const aforoSnap = await tx.get(aforoRef);
    const ocupadas = aforoSnap.exists ? Number(aforoSnap.data().ocupadas) || 0 : 0;
    if (ocupadas >= limite) throw new Error("Completo a esa hora. Prueba otra franja.");

    const codigo = generarCodigo();
    const nuevaRef = db.collection("reservas").doc();
    tx.set(nuevaRef, {
      uid,
      email: usuario?.email || "",
      restaurantId: restId,
      restauranteId: restId,
      nombreRestaurante: restaurante.nombre || "",
      usuarioNombre: usuario?.displayName || usuario?.nombre || "",
      usuarioEmail: usuario?.email || "",
      ciudad: restaurante.ciudad || "",
      zona: restaurante.zona_busqueda || restaurante.zona || "",
      lat: null,
      lng: null,
      terraza: restaurante.terraza ?? null,
      fecha,
      hora,
      comensales: n,
      comentarios: (comentarios || "").trim(),
      estado: "pendiente",
      codigo,
      ticketId: null,
      puntosGenerados: 0,
      multiplicadorAplicado: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.set(aforoRef, { ocupadas: ocupadas + 1, limite }, { merge: true });

    return { id: nuevaRef.id, codigo, restauranteNombre: restaurante.nombre, fecha, hora, comensales: n };
  });

  logger.info({ uid, reservaId: result.id, restaurantId: restId, fecha, hora }, "Reservation created");
  return result;
}

async function cancelarReserva(reservaId, uid, esAdmin = false) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection("reservas").doc(reservaId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("La reserva ya no existe.");
    const r = snap.data();
    if (r.estado === "cancelada") throw new Error("Ya estaba cancelada.");
    if (!esAdmin && r.uid !== uid) throw new Error("No autorizado");

    tx.update(ref, { estado: "cancelada", updatedAt: new Date() });

    const aforoRef = db.collection("aforo").doc(aforoId(r.restaurantId, r.fecha, r.hora));
    const aforoSnap = await tx.get(aforoRef);
    const ocupadas = aforoSnap.exists ? Number(aforoSnap.data().ocupadas) || 0 : 0;
    tx.set(aforoRef, { ocupadas: Math.max(0, ocupadas - 1) }, { merge: true });
  });
  logger.info({ reservaId, uid }, "Reservation cancelled");
}

async function otorgarPuntosReserva(reserva, multiplicadorBase) {
  const userSnap = await db.collection("usuarios").doc(reserva.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const semanas = userData.rachaReservasSemanas || 0;
  const multiplicador = semanas >= 1 ? (multiplicadorBase || MULTIPLICADOR_RACHA) : 1;
  const puntos = Math.round(PUNTOS_RESERVA_BASE * multiplicador);

  await db.runTransaction(async (tx) => {
    const userRef = db.collection("usuarios").doc(reserva.uid);
    const currentSnap = await tx.get(userRef);
    if (!currentSnap.exists) return;
    const current = currentSnap.data();
    const nuevoSaldo = (current.saldoPuntos || 0) + puntos;
    tx.update(userRef, {
      saldoPuntos: nuevoSaldo,
      totalAcumulado: (current.totalAcumulado || 0) + puntos,
      updatedAt: new Date(),
    });
    const movRef = db.collection("puntos_movimientos").doc();
    tx.set(movRef, {
      uid: reserva.uid,
      tipo: "reserva",
      puntos,
      descripcion: `Reserva completada en ${reserva.nombreRestaurante || ""}`.trim(),
      createdAt: new Date(),
    });
    tx.update(db.collection("reservas").doc(reserva.id), {
      puntosGenerados: puntos,
      multiplicadorAplicado: multiplicador,
    });
  });

  return { puntos, multiplicador };
}

async function completarReserva(reservaId, { uid, precioManual, emitidoPor } = {}) {
  const reservaRef = db.collection("reservas").doc(reservaId);
  const reservaSnap = await reservaRef.get();
  if (!reservaSnap.exists) throw new Error("Reserva no encontrada");
  const reserva = { id: reservaSnap.id, ...reservaSnap.data() };

  if (reserva.estado === "completada") return { yaCompletada: true };

  await reservaRef.update({ estado: "completada", updatedAt: new Date() });
  const puntosResult = await otorgarPuntosReserva(reserva);

  let ticket = null;
  try {
    const { generarTicket } = require("../tickets/service");
    ticket = await generarTicket(reservaId, { precioManual, emitidoPor: emitidoPor || "sistema" });
  } catch (err) {
    logger.error({ reservaId, error: err.message }, "Ticket generation failed");
  }

  try {
    const { onInvitadoReservaCompletada } = require("../invitations/service");
    await onInvitadoReservaCompletada(reserva.uid);
  } catch (err) {
    logger.error({ reservaId, error: err.message }, "Invitation check failed");
  }

  logger.info({ reservaId, uid: reserva.uid }, "Reservation completed");
  return { completada: true, ticket, ...puntosResult };
}

function isIndexError(err) {
  const msg = String(err?.message || err?.code || "");
  return err?.code === "failed-precondition" || msg.includes("index") || msg.includes("FAILED_PRECONDITION");
}

async function listarReservas(uid, { estado } = {}) {
  try {
    let query = db.collection("reservas").where("uid", "==", uid).orderBy("fecha", "desc");
    if (estado) query = query.where("estado", "==", estado);
    const snapshot = await query.limit(100).get();
    return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    if (!isIndexError(err)) throw err;
    // Fallback sin orderBy: evita FAILED_PRECONDITION si el índice compuesto aún no está desplegado.
    const snapshot = await db.collection("reservas").where("uid", "==", uid).limit(200).get();
    let list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (estado) list = list.filter((r) => r.estado === estado);
    list.sort((a, b) => `${b.fecha || ""} ${b.hora || ""}`.localeCompare(`${a.fecha || ""} ${a.hora || ""}`));
    return list.slice(0, 100);
  }
}

async function subirTicket(reservaId, { uid, totalPagado, asistio = true, fileName = "", tipoDocumento = "Ticket TPV" }) {
  const reservaRef = db.collection("reservas").doc(reservaId);
  const snap = await reservaRef.get();
  if (!snap.exists) throw new Error("Reserva no encontrada");
  const r = snap.data();
  if (r.ticketId) throw new Error("Esta reserva ya tiene un ticket registrado (máx. 1 por reserva)");

  const yaExiste = await db.collection("tickets").where("reservaId", "==", reservaId).limit(1).get();
  if (!yaExiste.empty) throw new Error("Esta reserva ya tiene un ticket registrado (máx. 1 por reserva)");

  const rid = String(r.restaurantId || r.restauranteId || "");
  if (!rid) throw new Error("Reserva sin restaurante vinculado");
  const total = Number(totalPagado);
  if (!(total > 0)) throw new Error("Importe inválido");
  const restSnap = await db.collection("restaurants").doc(rid).get().catch(() => null);
  const comisionPct = Number(restSnap?.data?.()?.comisionPct) || Number(require("../../config/env").env.COMISION_PCT) || 8;
  const comision = Math.round((total * comisionPct) / 100 * 100) / 100;
  const neto = Math.round((total - comision) * 100) / 100;
  const comensales = Number(r.comensales) || 0;
  const nuevoEstado = asistio ? "completada" : "no_show";

  await db.runTransaction(async (tx) => {
    const ticketRef = db.collection("tickets").doc();
    tx.set(ticketRef, {
      restaurantId: rid,
      restauranteId: rid,
      reservaId,
      codigoReserva: r.codigo || reservaId.slice(0, 6).toUpperCase(),
      totalPagado: total,
      importeComision: comision,
      netoRestaurante: neto,
      comisionPct,
      asistio: Boolean(asistio),
      fileName: String(fileName || ""),
      tipoDocumento: String(tipoDocumento || "Ticket TPV"),
      fecha: r.fecha || new Date().toISOString().split("T")[0],
      clienteNombre: r.usuarioNombre || r.usuarioEmail || r.email || "",
      clienteUid: r.uid || "",
      restauranteNombre: r.nombreRestaurante || r.restaurantName || r.nombre || "",
      nombreRestaurante: r.nombreRestaurante || "",
      createdAt: new Date(),
      createdBy: uid,
      uid: r.uid || uid,
    });
    tx.update(reservaRef, {
      estado: nuevoEstado,
      totalPagado: total,
      importeComision: comision,
      netoRestaurante: neto,
      ticketId: ticketRef.id,
      updatedAt: new Date(),
      asistio: Boolean(asistio),
    });
    const finanzasRef = db.collection("finanzas_restaurante").doc(rid);
    const finSnap = await tx.get(finanzasRef);
    const fin = finSnap.exists ? finSnap.data() : {};
    tx.set(finanzasRef, {
      restaurantId: rid,
      ingresosBrutos: (Number(fin.ingresosBrutos) || 0) + total,
      comisiones: (Number(fin.comisiones) || 0) + comision,
      neto: (Number(fin.neto) || 0) + neto,
      totalTickets: (Number(fin.totalTickets) || 0) + 1,
      comensalesAtendidos: (Number(fin.comensalesAtendidos) || 0) + (asistio ? comensales : 0),
      baseImponible: (Number(fin.baseImponible) || 0) + Math.round(total / 1.1 * 100) / 100,
      updatedAt: new Date(),
      createdAt: fin.createdAt || new Date(),
    }, { merge: true });
    return { ticketId: ticketRef.id };
  });

  if (asistio) {
    const reservaActualizada = { id: reservaId, ...r, estado: nuevoEstado };
    try {
      await otorgarPuntosReserva(reservaActualizada);
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Points on ticket failed");
    }
    try {
      const { onInvitadoReservaCompletada } = require("../invitations/service");
      await onInvitadoReservaCompletada(r.uid);
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Invitation check failed");
    }
  }

  logger.info({ reservaId, total, comision, nuevoEstado }, "Ticket uploaded");
  return { ticketId: null, comision, neto, estado: nuevoEstado };
}

async function actualizarEstado(reservaId, status, { precioBase } = {}) {
  const reservaRef = db.collection("reservas").doc(reservaId);
  const snap = await reservaRef.get();
  if (!snap.exists) throw new Error("Reserva no encontrada");
  const reserva = { id: snap.id, ...snap.data() };
  const estabaCompletada = reserva.estado === "completada";

  const update = { estado: status, updatedAt: new Date() };
  if (status === "completada") {
    update.asistio = true;
    if (precioBase) {
      const restSnap2 = await db.collection("restaurants").doc(reserva.restaurantId || reserva.restauranteId || "").get().catch(() => null);
      const pct2 = Number(restSnap2?.data?.()?.comisionPct) || Number(require("../../config/env").env.COMISION_PCT) || 8;
      update.totalPagado = Number(precioBase);
      update.importeComision = Math.round((Number(precioBase) * pct2) / 100 * 100) / 100;
    }
  }
  if (status === "no_show") update.asistio = false;
  await reservaRef.update(update);

  if (status === "completada" && !estabaCompletada) {
    try {
      await otorgarPuntosReserva(reserva);
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Points on complete failed");
    }
    try {
      const { generarTicket } = require("../tickets/service");
      await generarTicket(reservaId, { precioManual: precioBase, emitidoPor: "restaurante-simulado" });
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Ticket generation failed");
    }
    try {
      const { onInvitadoReservaCompletada } = require("../invitations/service");
      await onInvitadoReservaCompletada(reserva.uid);
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Invitation check failed");
    }
  }

  if (status === "no_show") {
    const aforoRef = db.collection("aforo").doc(aforoId(reserva.restaurantId, reserva.fecha, reserva.hora));
    const aforoSnap = await aforoRef.get();
    if (aforoSnap.exists) {
      const ocupadas = aforoSnap.data().ocupadas || 0;
      await aforoRef.update({ ocupadas: Math.max(0, ocupadas - 1) });
    }
  }

  logger.info({ reservaId, status }, "Reservation status updated");
  return { updated: true, status };
}

module.exports = {
  limitePorResenas,
  limiteDelLocal,
  aforoId,
  getDisponibilidad,
  crearReserva,
  cancelarReserva,
  completarReserva,
  listarReservas,
  subirTicket,
  actualizarEstado,
};
