const push = require("./service");
const { logger } = require("../../middlewares/errorHandler");

const textos = {
  confirmada: {
    es: { titulo: "Reserva confirmada", cuerpo: "Tu reserva ha sido confirmada. Consulta los detalles en MIRA." },
    ca: { titulo: "Reserva confirmada", cuerpo: "La teva reserva s'ha confirmat. Consulta els detalls a MIRA." },
    en: { titulo: "Reservation confirmed", cuerpo: "Your reservation has been confirmed. Check the details in MIRA." },
  },
  cancelada: {
    es: { titulo: "Reserva cancelada", cuerpo: "Tu reserva ha sido cancelada. Consulta los detalles en MIRA." },
    ca: { titulo: "Reserva cancel·lada", cuerpo: "La teva reserva s'ha cancel·lat. Consulta els detalls a MIRA." },
    en: { titulo: "Reservation cancelled", cuerpo: "Your reservation has been cancelled. Check the details in MIRA." },
  },
  mensaje: {
    es: { titulo: "Nuevo mensaje", cuerpo: "Tienes un nuevo mensaje en tu buzón de MIRA." },
    ca: { titulo: "Missatge nou", cuerpo: "Tens un missatge nou a la teva bústia de MIRA." },
    en: { titulo: "New message", cuerpo: "You have a new message in your MIRA inbox." },
  },
};

// Solo después de guardar la acción. Un fallo de push no revierte una reserva
// ni convierte en error el envío de un mensaje ya persistido.
async function notificar(uid, evento, data) {
  if (!uid) return;
  try {
    await push.enviarPush(uid, {
      tipo: evento === "mensaje" ? "mensajes" : "reservas",
      ...textos[evento].es, textos: textos[evento], data,
    });
  } catch {
    logger.warn({ evento }, "No se pudo completar el aviso push");
  }
}

async function notificarReserva(uid, reservaId, estado) {
  if (!["confirmada", "cancelada"].includes(estado)) return;
  await notificar(uid, estado, { ruta: "reservas", reservaId, estado });
}

async function notificarMensaje(uid, mensajeId) {
  await notificar(uid, "mensaje", { ruta: "mensajes", mensajeId });
}

module.exports = { notificarReserva, notificarMensaje };
