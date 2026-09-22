const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { calcularPrecioBase, generarCodigo } = require("../../config/constants");

async function generarTicket(reservaId, opts = {}) {
  const { precioManual } = opts;

  const result = await db.runTransaction(async (tx) => {
    const reservaRef = db.collection("reservas").doc(reservaId);
    const reservaSnap = await tx.get(reservaRef);
    if (!reservaSnap.exists) throw new Error("Reserva no encontrada");
    const reserva = reservaSnap.data();

    if (reserva.estado !== "completada") throw new Error("Reserva no completada");

    const existingTicket = await db.collection("tickets").where("reservaId", "==", reservaId).limit(1).get();
    if (!existingTicket.empty) return { ticketId: existingTicket.docs[0].id, yaExistia: true };

    const restSnap = await tx.get(db.collection("restaurants").doc(reserva.restaurantId));
    const restaurante = restSnap.data() || {};

    const precioBase = calcularPrecioBase(restaurante, reserva.comensales, precioManual);
    const comisionPct = restaurante.comisionPct || 8;
    const descuentoAplicado = 0;
    const totalPagado = Math.round((precioBase - descuentoAplicado) * 100) / 100;
    const importeComision = Math.round(totalPagado * comisionPct / 100 * 100) / 100;

    const ticketRef = db.collection("tickets").doc();
    tx.set(ticketRef, {
      reservaId,
      uid: reserva.uid,
      restaurantId: reserva.restaurantId,
      nombreRestaurante: reserva.nombreRestaurante,
      precioBase,
      descuentoAplicado,
      totalPagado,
      puntosCanjeados: 0,
      comisionPct,
      importeComision,
      estado: "emitido",
      emitidoPor: opts.emitidoPor || "sistema",
      createdAt: new Date(),
    });

    await tx.update(reservaRef, { ticketId: ticketRef.id, updatedAt: new Date() });

    logger.info({ ticketId: ticketRef.id, reservaId, precioBase, importeComision }, "Ticket generated");
    return { ticketId: ticketRef.id, precioBase, importeComision, yaExistia: false };
  });

  return result;
}

async function getTicket(ticketId, uid, role) {
  const doc = await db.collection("tickets").doc(ticketId).get();
  if (!doc.exists) throw new Error("Ticket no encontrado");
  const ticket = { id: doc.id, ...doc.data() };
  if (uid && ticket.uid !== uid && role !== "admin" && role !== "empresa") {
    throw new Error("No autorizado");
  }
  return ticket;
}

async function getTicketsByUser(uid, { page = 1, limit = 20 } = {}) {
  const snapshot = await db.collection("tickets").where("uid", "==", uid).orderBy("createdAt", "desc").limit(limit).get();
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { generarTicket, getTicket, getTicketsByUser };
