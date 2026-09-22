const { env } = require("./env");

const SLOTS = ["12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "20:00", "20:30", "21:00", "21:30", "22:00"];

const PRECIO_MAP = { "€": 18, "€€": 32, "€€€": 55 };

const PUNTOS_RESERVA_BASE = env.PUNTOS_RESERVA_BASE;
const MULTIPLICADOR_RACHA = env.MULTIPLICADOR_RACHA;
const PUNTOS_LOGIN_BASE = env.PUNTOS_LOGIN_BASE;
const PUNTOS_LOGIN_INCREMENTO = env.PUNTOS_LOGIN_INCREMENTO;
const PUNTOS_LOGIN_CAP = env.PUNTOS_LOGIN_CAP;
const PUNTOS_LOGIN_GRACE_MAX = env.PUNTOS_LOGIN_GRACE_MAX;
const PUNTOS_INVITACION = env.PUNTOS_INVITACION;
const INVITACIONES_MAX_MES = env.INVITACIONES_MAX_MES;
const INVITACIONES_RESERVAS_REQUERIDAS = env.INVITACIONES_RESERVAS_REQUERIDAS;
const PUNTOS_REVIEW = env.PUNTOS_REVIEW;
const PUNTOS_PROMO_VIEW = env.PUNTOS_PROMO_VIEW;
const PUNTOS_PROMO_CLICK = env.PUNTOS_PROMO_CLICK;

function precioMedio(restaurante) {
  const precio = restaurante.precio || restaurante.precioRango || "€€";
  return PRECIO_MAP[precio] || 32;
}

function calcularPrecioBase(restaurante, comensales, precioManual) {
  if (precioManual && precioManual > 0) return Math.round(precioManual * 100) / 100;
  const base = precioMedio(restaurante);
  const comensalesExtra = Math.max(0, comensales - 2);
  return Math.round((base + comensalesExtra * 5) * 100) / 100;
}

function generarCodigo() {
  return `MIRA-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function generarInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function hoyISO() {
  return new Date().toISOString().split("T")[0];
}

function semanaISO(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return `${d.getFullYear()}-W${String(1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)).padStart(2, "0")}`;
}

function inicioMes() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
}

module.exports = {
  SLOTS,
  PRECIO_MAP,
  precioMedio,
  calcularPrecioBase,
  generarCodigo,
  generarInviteCode,
  hoyISO,
  semanaISO,
  inicioMes,
  PUNTOS_RESERVA_BASE,
  MULTIPLICADOR_RACHA,
  PUNTOS_LOGIN_BASE,
  PUNTOS_LOGIN_INCREMENTO,
  PUNTOS_LOGIN_CAP,
  PUNTOS_LOGIN_GRACE_MAX,
  PUNTOS_INVITACION,
  INVITACIONES_MAX_MES,
  INVITACIONES_RESERVAS_REQUERIDAS,
  PUNTOS_REVIEW,
  PUNTOS_PROMO_VIEW,
  PUNTOS_PROMO_CLICK,
};
