const nodemailer = require("nodemailer");
const { env } = require("../../config/env");
const { logger } = require("../../middlewares/errorHandler");

// Dependencias inyectables para probar sin conectar con Gmail.
async function enviarInvitacion({ email, codigo }, { config = env, createTransport = nodemailer.createTransport, log = logger } = {}) {
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    log.warn("SMTP sin credenciales: invitación creada sin enviar correo");
    return false;
  }
  const link = `${config.FRONTEND_URL.replace(/\/$/, "")}/#/registro?invite=${encodeURIComponent(codigo)}`;
  try {
    const transport = createTransport({
      host: config.SMTP_HOST, port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      requireTLS: config.SMTP_PORT !== 465,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    await transport.sendMail({
      from: config.MAIL_FROM || config.SMTP_USER, to: email,
      subject: "Te han invitado a MIRA",
      text: `¡Te han invitado a MIRA!\nRegístrate con este enlace: ${link}\nTu código de invitación: ${codigo}\nTras completar dos reservas, ambos recibiréis puntos.`,
    });
    return true;
  } catch (error) {
    // No registrar el objeto del error SMTP: puede contener credenciales o PII.
    log.warn({ code: error.code || "SMTP_ERROR" }, "No se pudo enviar el correo; la invitación sigue creada");
    return false;
  }
}

module.exports = { enviarInvitacion };
