"use strict";

const restaurantService = require("../../restaurants/service");
const promotionService = require("../../promotions/service");
const interactionsService = require("../../interactions/service");
const reviewsService = require("../../reviews/service");
const dashboardService = require("../../dashboard/service");

const MAX_ITEMS = 50;

const UPDATE_FIELDS = [
  "nombre",
  "direccion",
  "telefono",
  "email",
  "activo",
  "ciudad",
  "zona",
  "precio",
  "cocina",
  "descripcion",
  "comisionPct",
  "maxReservasPorHora",
];

function requireUid(ctx) {
  const uid = ctx && ctx.user ? ctx.user.uid : null;
  if (!uid) {
    throw Object.assign(new Error("Inicia sesión para usar esta función."), { code: "MISSING_TOKEN" });
  }
  return uid;
}

function requireString(args, key, label) {
  const value = args && args[key] ? String(args[key]).trim() : "";
  if (!value) {
    throw Object.assign(new Error(`${label || key} requerido.`), { code: "VALIDATION_ERROR" });
  }
  return value;
}

function numero(args, key) {
  if (!args || args[key] === undefined || args[key] === null || args[key] === "") return undefined;
  const valor = Number(args[key]);
  if (!Number.isFinite(valor)) {
    throw Object.assign(new Error(`El campo ${key} debe ser un número.`), { code: "VALIDATION_ERROR" });
  }
  return valor;
}

module.exports = {
  countRestaurants: async (ctx, args) => {
    const total = await restaurantService.contarRestaurantes();
    return { total, count: total };
  },

  listPromotions: async (ctx, args) => {
    const a = args || {};
    const promos = await promotionService.getPromociones({
      restauranteId: a.restauranteId || null,
      estado: a.estado || null,
    });
    return (Array.isArray(promos) ? promos : []).slice(0, MAX_ITEMS);
  },

  listReviews: async (ctx, args) => {
    const restauranteId = requireString(args, "restauranteId", "restauranteId");
    const list = await reviewsService.listarResenasDeRestaurante(restauranteId);
    return (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS);
  },

  trackInteraction: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const restauranteId = requireString(a, "restauranteId", "restauranteId");
    const tipo = String(a.tipo || "").trim().toLowerCase();
    if (tipo !== "view" && tipo !== "click") {
      throw Object.assign(new Error("Tipo de interacción inválido. Usa view o click."), {
        code: "VALIDATION_ERROR",
      });
    }
    return tipo === "click"
      ? interactionsService.registrarClick(uid, restauranteId)
      : interactionsService.registrarVista(uid, restauranteId);
  },

myRestaurants: async (ctx, args) => {
    const uid = requireUid(ctx);
    const currentId = (args || {}).currentId || null;
    const lista = await dashboardService.listMyRestaurants(uid, ctx.user.email || null, currentId);
    const out = (Array.isArray(lista) ? lista : []).slice(0, MAX_ITEMS);
    if (out.length === 0) {
      // Un admin que aprueba propuestas de otros no tiene restaurantes propios.
      return {
        restaurantes: out,
        hint:
          "Este usuario no tiene restaurantes propios asignados. Si es un admin que acaba de aprobar una propuesta, " +
          "el restaurante pertenece al dueño de la propuesta: búscalo con searchRestaurants por nombre o pide su id. " +
          "No digas que está activo si no lo has verificado.",
      };
    }
    return out;
    },

    myRestaurant: async (ctx, args) => {
    const uid = requireUid(ctx);
    const id = (args || {}).id || null;
    return dashboardService.getMyRestaurant(uid, id, ctx.user.role);
    },

  updateRestaurant: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const restaurantId = requireString(a, "restaurantId", "restaurantId");
    const data = {};
    UPDATE_FIELDS.forEach((campo) => {
      if (a[campo] === undefined || a[campo] === null || a[campo] === "") return;
      data[campo] = a[campo];
    });
    if (data.comisionPct !== undefined) data.comisionPct = numero(a, "comisionPct");
    if (data.maxReservasPorHora !== undefined) data.maxReservasPorHora = numero(a, "maxReservasPorHora");
    return restaurantService.actualizarRestaurante(restaurantId, uid, data);
  },

  createPromotion: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const restauranteId = requireString(a, "restauranteId", "restauranteId");
    const fechaInicio = requireString(a, "fechaInicio", "fechaInicio");
    const fechaFin = requireString(a, "fechaFin", "fechaFin");
    const presupuestoTotal = numero(a, "presupuestoTotal");
    if (!(presupuestoTotal > 0)) {
      throw Object.assign(new Error("El presupuesto total debe ser un número mayor que 0."), {
        code: "VALIDATION_ERROR",
      });
    }
    return promotionService.crearPromocion({
      uid,
      restauranteId,
      fechaInicio,
      fechaFin,
      presupuestoTotal,
      tipo: a.tipo || undefined,
      cpc: numero(a, "cpc"),
      puntosExtraPorReserva: numero(a, "puntosExtraPorReserva"),
    });
  },

  promoStats: async (ctx, args) => {
    const promoId = requireString(args, "promoId", "promoId");
    return promotionService.getPromoStats(promoId);
  },

  dashboardTicket: async (ctx, args) => {
    const uid = requireUid(ctx);
    const reservaId = requireString(args, "reservaId", "reservaId");
    const data = await dashboardService.getMyRestaurant(uid, null);
    const ticket = (data.ticketsRecientes || []).find((t) => String(t.reservaId || "") === reservaId);
    if (!ticket) {
      throw Object.assign(new Error("Ticket no encontrado para la reserva."), { code: "NOT_FOUND" });
    }
    return ticket;
  },
};