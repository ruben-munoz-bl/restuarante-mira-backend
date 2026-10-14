const { env } = require("../../config/env");
const { logger } = require("../../middlewares/errorHandler");

function escaparHtml(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function remitente(valor) {
  const match = String(valor || "").trim().match(/^(.*?)\s*<([^<>]+)>$/);
  return match ? { name: match[1].trim() || "MIRA", email: match[2].trim() } : { email: String(valor || "").trim() };
}

// fetch inyectable: los tests nunca contactan a Brevo ni usan claves reales.
async function enviarInvitacion({ email, codigo }, { config = env, fetchImpl = globalThis.fetch, log = logger } = {}) {
  const noEnviado = { emailEstado: "no_enviado", messageId: null };
  if (!config.BREVO_API_KEY) {
    log.warn("Brevo sin clave: invitación creada sin enviar correo");
    return noEnviado;
  }
  const sender = remitente(config.MAIL_FROM);
  if (!sender.email) {
    log.warn("Brevo sin remitente: invitación creada sin enviar correo");
    return noEnviado;
  }
  const link = `${config.FRONTEND_URL.replace(/\/$/, "")}/#/registro?invite=${encodeURIComponent(codigo)}`;
  try {
    const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        sender, to: [{ email }], subject: "Te han invitado a MIRA",
        textContent: `¡Te han invitado a MIRA!\nRegístrate con este enlace: ${link}\nTu código de invitación: ${codigo}\nTras completar dos reservas, ambos recibiréis puntos.`,
        htmlContent: `<h1>¡Te han invitado a MIRA!</h1><p><a href="${escaparHtml(link)}">Regístrate en MIRA</a></p><p>Tu código de invitación: <strong>${escaparHtml(codigo)}</strong></p><p>Tras completar dos reservas, ambos recibiréis puntos.</p>`,
      }),
    });
    if (!response.ok) {
      // No leer ni registrar la respuesta de error: puede contener PII.
      log.warn({ status: response.status }, "Brevo no aceptó el correo; la invitación sigue creada");
      return noEnviado;
    }
    const data = await response.json();
    if (typeof data.messageId !== "string" || !data.messageId || data.messageId.length > 500) {
      log.warn("Brevo no devolvió un identificador de mensaje válido");
      return noEnviado;
    }
    return { emailEstado: "enviado", messageId: data.messageId };
  } catch {
    // No registrar el objeto del error, la clave ni el cuerpo de la respuesta.
    log.warn("No se pudo enviar el correo con Brevo; la invitación sigue creada");
    return noEnviado;
  }
}

module.exports = { enviarInvitacion };
