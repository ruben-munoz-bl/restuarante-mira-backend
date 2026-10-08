/**
 * Envía un mensaje al buzón de la web de un usuario (colección `mensajes`).
 * `enlace` es una ruta de la web (#/...) que la bandeja muestra como botón.
 * Best-effort: un fallo al avisar nunca debe romper la acción que lo provoca.
 */
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function enviarMensaje(uid, { titulo, cuerpo, enlace = null, enlaceTexto = null, tipo = "sistema", extra = {} }) {
  if (!uid) return null;
  const ahora = new Date();
  try {
    const ref = await db.collection("mensajes").add({
      uid,
      titulo,
      cuerpo,
      enlace,
      enlaceTexto,
      tipo,
      leido: false,
      fecha: new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(ahora),
      hora: new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).format(ahora),
      creado: ahora,
      ...extra,
    });
    return ref.id;
  } catch (err) {
    logger.warn({ uid, tipo, err: err.message }, "No se pudo enviar el mensaje");
    return null;
  }
}

module.exports = { enviarMensaje };
