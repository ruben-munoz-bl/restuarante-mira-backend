const reservationService = require("../../reservations/service");

const MAX_RESERVATIONS = 50;
const VALID_STATUSES = new Set(["pendiente", "confirmada", "completada", "cancelada", "no_show"]);

function requireUid(ctx) {
  const uid = ctx && ctx.user ? ctx.user.uid : null;
  if (!uid) {
    throw Object.assign(new Error("Inicia sesión para usar esta función."), { code: "MISSING_TOKEN" });
  }
  return uid;
}

function requireReservaId(args) {
  const reservaId = args && args.reservaId ? String(args.reservaId) : "";
  if (!reservaId) {
    throw Object.assign(new Error("Falta el identificador de la reserva."), { code: "VALIDATION_ERROR" });
  }
  return reservaId;
}

function precioBase(args) {
  const a = args || {};
  if (a.precioBase === undefined || a.precioBase === null || a.precioBase === "") return undefined;
  const valor = Number(a.precioBase);
  if (!Number.isFinite(valor) || valor < 0) {
    throw Object.assign(new Error("El importe cobrado debe ser un número mayor o igual que 0."), {
      code: "VALIDATION_ERROR",
    });
  }
  return valor;
}

module.exports = {
  listMyReservations: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const estado = a.estado ? String(a.estado) : null;
    const list = await reservationService.listarReservas(uid, { estado });
    return Array.isArray(list) ? list.slice(0, MAX_RESERVATIONS) : list;
  },

  completeReservation: async (ctx, args) => {
    const uid = requireUid(ctx);
    const reservaId = requireReservaId(args);
    return reservationService.completarReserva(reservaId, {
      uid,
      precioManual: precioBase(args),
      emitidoPor: "agente-ia",
    });
  },

  reservationTicket: async (ctx, args) => {
    const uid = requireUid(ctx);
    const reservaId = requireReservaId(args);
    const a = args || {};
    const totalPagado = Number(a.totalPagado);
    if (!Number.isFinite(totalPagado) || totalPagado <= 0) {
      throw Object.assign(new Error("El importe total pagado debe ser un número mayor que 0."), {
        code: "VALIDATION_ERROR",
      });
    }
    return reservationService.subirTicket(reservaId, {
      uid,
      totalPagado,
      asistio: a.asistio === undefined || a.asistio === null ? true : Boolean(a.asistio),
      fileName: a.fileName || "",
      tipoDocumento: a.tipoDocumento || "Ticket TPV",
    });
  },

  updateReservationStatus: async (ctx, args) => {
    requireUid(ctx);
    const reservaId = requireReservaId(args);
    const status = String((args || {}).status || "").trim().toLowerCase();
    if (!VALID_STATUSES.has(status)) {
      throw Object.assign(
        new Error(`Estado no válido. Usa uno de: ${[...VALID_STATUSES].join(", ")}.`),
        { code: "VALIDATION_ERROR" },
      );
    }
    return reservationService.actualizarEstado(reservaId, status, { precioBase: precioBase(args) });
  },

  confirmAttendance: async (ctx, args) => {
    requireUid(ctx);
    const reservaId = requireReservaId(args);
    return reservationService.actualizarEstado(reservaId, "completada", { precioBase: precioBase(args) });
  },

  markNoShow: async (ctx, args) => {
    requireUid(ctx);
    const reservaId = requireReservaId(args);
    return reservationService.actualizarEstado(reservaId, "no_show", {});
  },
};