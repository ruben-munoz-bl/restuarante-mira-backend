const { createHmac, timingSafeEqual } = require("crypto");

const DURACION_MS = 15 * 60 * 1000;
const RADIO_LLEGADA = 50;

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function comprobarSecreto(secreto) {
  if (typeof secreto !== "string" || secreto.length < 32) {
    throw error(503, "VISITAS_NO_CONFIGURADO", "Configura VISITAS_SECRET (mínimo 32 caracteres)");
  }
}

function firmarQr(visitaId, caducaEnMs, secreto) {
  comprobarSecreto(secreto);
  const contenido = `v1.${visitaId}.${caducaEnMs}`;
  return `${contenido}.${createHmac("sha256", secreto).update(contenido).digest("base64url")}`;
}

// El formato canónico evita aceptar codificaciones distintas de la misma firma.
// Solo se compara con timingSafeEqual cuando ambos buffers tienen 32 bytes.
function leerQr(qr, secreto) {
  comprobarSecreto(secreto);
  const partes = /^v1\.([A-Za-z0-9_-]{1,200})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/.exec(qr);
  const invalido = () => error(400, "QR_INVALIDO", "QR inválido");
  if (!partes) throw invalido();
  const [, visitaId, tiempo, firma] = partes;
  const caducaEnMs = Number(tiempo);
  if (!Number.isSafeInteger(caducaEnMs)) throw invalido();
  const recibida = Buffer.from(firma, "base64url");
  const esperada = createHmac("sha256", secreto).update(`v1.${visitaId}.${tiempo}`).digest();
  if (recibida.length !== esperada.length || recibida.toString("base64url") !== firma || !timingSafeEqual(recibida, esperada)) throw invalido();
  return { visitaId, caducaEnMs };
}

function estadoVisita(visita, ahora = Date.now()) {
  return visita.estado === "pendiente" && Date.parse(visita.caducaEn) <= ahora ? "caducada" : visita.estado;
}

module.exports = { DURACION_MS, RADIO_LLEGADA, error, comprobarSecreto, firmarQr, leerQr, estadoVisita };
