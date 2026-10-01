"use strict";

const adminService = require("../../admin/service");
const dashboardService = require("../../dashboard/service");
const usersService = require("../../users/service");
const negociosService = require("../../negocios/service");
const contactosService = require("../../contactos/service");
const pointsService = require("../../points/service");

const MAX_ITEMS = 100;
const DEFAULT_RESERVAS_LIMIT = 20;
const MAX_PUNTOS_MANUAL = 100000;
const MAX_MOTIVO = 200;
const MAX_DIAS_RACHA = 7;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

function requireString(args, key, label) {
  const value = args && args[key] !== undefined && args[key] !== null ? String(args[key]).trim() : "";
  if (!value) throw invalid(`${label || key} requerido.`);
  return value;
}

function entero(args, key, label) {
  const n = Number(args ? args[key] : NaN);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw invalid(`${label || key} debe ser un número entero.`);
  }
  return n;
}

function fecha(args, key, label) {
  const raw = args && args[key] !== undefined && args[key] !== null && args[key] !== ""
    ? String(args[key]).trim()
    : "";
  if (!raw) return null;
  if (!FECHA_RE.test(raw) || Number.isNaN(new Date(raw).getTime())) {
    throw invalid(`${label || key} debe tener formato YYYY-MM-DD.`);
  }
  return raw;
}

function limitarLista(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS);
}

function limitarObjeto(obj) {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(Object.entries(obj).slice(0, MAX_ITEMS));
}

module.exports = {
  listAllUsers: async (ctx, args) => {
    const users = await usersService.getAllUsers();
    const list = Array.isArray(users) ? users : [];
    return { total: list.length, usuarios: list.slice(0, MAX_ITEMS) };
  },

  adminOverview: async (ctx, args) => {
    const data = (await dashboardService.getAdminDashboard()) || {};
    return {
      ...data,
      reservasPorRestaurante: limitarObjeto(data.reservasPorRestaurante),
      facturacionPorMes: limitarObjeto(data.facturacionPorMes),
      ticketsRecientes: limitarLista(data.ticketsRecientes),
    };
  },

  opsOverview: async (ctx, args) => {
    const data = (await dashboardService.getOpsOverview()) || {};
    return {
      ...data,
      serie: limitarLista(data.serie),
      feed: limitarLista(data.feed),
      top: limitarLista(data.top),
      incidenciasPreview: limitarLista(data.incidenciasPreview),
    };
  },

  adminReservations: async (ctx, args) => {
    const a = args || {};
    const rawLimite = Number(a.limite);
    const limite = Number.isFinite(rawLimite) && rawLimite > 0
      ? Math.min(Math.floor(rawLimite), MAX_ITEMS)
      : DEFAULT_RESERVAS_LIMIT;
    const list = await dashboardService.getReservasGlobales({
      q: a.q ? String(a.q) : "",
      estado: a.estado ? String(a.estado) : "",
      limite,
    });
    return limitarLista(list);
  },

  dashboardUsers: async (ctx, args) => {
    const users = await usersService.getAllUsers();
    const list = Array.isArray(users) ? users : [];
    return { total: list.length, usuarios: list.slice(0, MAX_ITEMS) };
  },

  addManualPoints: async (ctx, args) => {
    const a = args || {};
    const uid = requireString(a, "uid", "uid");
    const cantidad = entero(a, "cantidad", "cantidad");
    if (cantidad === 0) throw invalid("La cantidad debe ser distinta de 0.");
    if (cantidad < -MAX_PUNTOS_MANUAL || cantidad > MAX_PUNTOS_MANUAL) {
      throw invalid(`La cantidad debe estar entre -${MAX_PUNTOS_MANUAL} y ${MAX_PUNTOS_MANUAL}.`);
    }
    const motivo = requireString(a, "motivo", "motivo");
    if (motivo.length > MAX_MOTIVO) {
      throw invalid(`El motivo no puede superar ${MAX_MOTIVO} caracteres.`);
    }
    const result = await dashboardService.addPointsManually(uid, cantidad, motivo);
    return { ok: true, uid, cantidad, ...result };
  },

  setRacha: async (ctx, args) => {
    const a = args || {};
    const uid = requireString(a, "uid", "uid");
    const dias = entero(a, "dias", "dias");
    if (dias < 0 || dias > MAX_DIAS_RACHA) {
      throw invalid(`La racha debe ser un entero entre 0 y ${MAX_DIAS_RACHA} días.`);
    }
    const balance = await dashboardService.setRachaAdmin(uid, dias);
    return { ok: true, uid, rachaLogin: balance.rachaLogin, saldoActual: balance.saldoActual };
  },

  deltaRacha: async (ctx, args) => {
    const a = args || {};
    const uid = requireString(a, "uid", "uid");
    const delta = entero(a, "delta", "delta");
    if (delta === 0) throw invalid("delta no puede ser 0.");
    if (delta < -MAX_DIAS_RACHA || delta > MAX_DIAS_RACHA) {
      throw invalid(`delta debe ser un entero entre -${MAX_DIAS_RACHA} y ${MAX_DIAS_RACHA}.`);
    }
    const before = await pointsService.getBalance(uid);
    const actual = Math.min(Math.max(Number(before.rachaLogin && before.rachaLogin.dias) || 0, 0), MAX_DIAS_RACHA);
    const nuevo = actual + delta;
    if (nuevo < 0 || nuevo > MAX_DIAS_RACHA) {
      throw invalid(`La racha del usuario es ${actual} días: con delta ${delta} quedaría fuera del rango 0-${MAX_DIAS_RACHA}.`);
    }
    const balance = await dashboardService.ajustarRachaDias(uid, delta);
    return { ok: true, uid, delta, rachaLogin: balance.rachaLogin };
  },

  unclaimToday: async (ctx, args) => {
    const uid = requireString(args || {}, "uid", "uid");
    const result = await dashboardService.unclaimLoginHoy(uid);
    return {
      ok: true,
      uid,
      estabaReclamadoHoy: result.estabaReclamadoHoy,
      rachaLogin: result.balance ? result.balance.rachaLogin : null,
    };
  },

  revenue: async (ctx, args) => {
    const a = args || {};
    const from = fecha(a, "from", "from");
    const to = fecha(a, "to", "to");
    if (from && to && from > to) throw invalid("'from' debe ser anterior o igual a 'to'.");
    const data = (await adminService.getRevenue({ from: from || undefined, to: to || undefined })) || {};
    return { ...data, porRestaurante: limitarObjeto(data.porRestaurante) };
  },

  fraudFlags: async (ctx, args) => {
    const flags = await adminService.getFraudFlags();
    return limitarLista(flags);
  },

  pendingNegocios: async (ctx, args) => {
    const list = await negociosService.listarNegociosPendientes();
    return limitarLista(list);
  },

  approveNegocio: async (ctx, args) => {
    const negocioId = requireString(args || {}, "negocioId", "negocioId");
    const restauranteId = await negociosService.aprobarNegocio(negocioId);
    return { ok: true, negocioId, restauranteId };
  },

  rejectNegocio: async (ctx, args) => {
    const negocioId = requireString(args || {}, "negocioId", "negocioId");
    await negociosService.rechazarNegocio(negocioId);
    return { ok: true, negocioId };
  },

  pendingContactos: async (ctx, args) => {
    const list = await contactosService.listarPendientes();
    return limitarLista(list);
  },

  resolveContacto: async (ctx, args) => {
    const contactoId = requireString(args || {}, "contactoId", "contactoId");
    await contactosService.resolverIncidencia(contactoId);
    return { ok: true, contactoId };
  },
};
