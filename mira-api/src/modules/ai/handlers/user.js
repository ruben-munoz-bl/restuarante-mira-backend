"use strict";

const usersService = require("../../users/service");
const mensajesService = require("../../mensajes/service");
const contactosService = require("../../contactos/service");
const negociosService = require("../../negocios/service");

const MAX_ITEMS = 50;
const PRECIOS = ["€", "€€", "€€€"];

const PERFIL_PERMITIDOS = ["nombre", "email", "soloVegano", "alergias", "lang", "favoritos"];

const PERFIL_PROHIBIDOS = [
  "tipo",
  "rol",
  "role",
  "saldoPuntos",
  "rachaLoginDias",
  "totalAcumulado",
  "totalCanjeado",
];

function requireUid(ctx) {
  const uid = ctx && ctx.user ? ctx.user.uid : null;
  if (!uid) {
    throw Object.assign(new Error("Inicia sesión para usar esta función."), { code: "MISSING_TOKEN" });
  }
  return uid;
}

function requireTexto(a, key) {
  const value = String(a[key] || "").trim();
  if (!value) {
    throw Object.assign(new Error(`El campo "${key}" es obligatorio.`), { code: "VALIDATION_ERROR" });
  }
  return value;
}

module.exports = {
  updateMe: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};

    const prohibido = PERFIL_PROHIBIDOS.find((k) => a[k] !== undefined && a[k] !== null);
    if (prohibido) {
      throw Object.assign(new Error(`No se puede modificar el campo "${prohibido}".`), {
        code: "VALIDATION_ERROR",
      });
    }

    const datos = {};
    for (const key of PERFIL_PERMITIDOS) {
      if (a[key] !== undefined) datos[key] = a[key];
    }

    return usersService.updateMe(uid, datos);
  },

  listMensajes: async (ctx, args) => {
    const uid = requireUid(ctx);
    const list = (await mensajesService.listarMensajes(uid)) || [];
    const ordenados = list
      .map((m, i) => ({ m, i }))
      .sort((x, y) => {
        const leidoX = x.m.leido === true ? 1 : 0;
        const leidoY = y.m.leido === true ? 1 : 0;
        if (leidoX !== leidoY) return leidoX - leidoY;
        return x.i - y.i;
      })
      .map((x) => x.m);
    return ordenados.slice(0, MAX_ITEMS);
  },

  unreadCount: async (ctx, args) => {
    const uid = requireUid(ctx);
    const count = await mensajesService.contarNoLeidos(uid);
    return { count: Number(count) || 0 };
  },

  markRead: async (ctx, args) => {
    const uid = requireUid(ctx);
    const mensajeId = requireTexto(args || {}, "mensajeId");
    const list = (await mensajesService.listarMensajes(uid)) || [];
    if (!list.some((m) => m.id === mensajeId)) {
      throw Object.assign(new Error("No se encontró el mensaje solicitado."), { code: "NOT_FOUND" });
    }
    return mensajesService.marcarLeido(mensajeId);
  },

  createContacto: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    return contactosService.crearContacto({
      uid,
      nombre: requireTexto(a, "nombre"),
      email: requireTexto(a, "email"),
      motivo: requireTexto(a, "motivo"),
      mensaje: requireTexto(a, "mensaje"),
    });
  },

  listMine: async (ctx, args) => {
    const uid = requireUid(ctx);
    const list = (await contactosService.listarMisIncidencias(uid)) || [];
    return list.slice(0, MAX_ITEMS);
  },

  createNegocio: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};

    const nombre = requireTexto(a, "nombre");
    const ciudad = requireTexto(a, "ciudad");
    const zona = requireTexto(a, "zona");
    const direccion = requireTexto(a, "direccion");
    const precio = requireTexto(a, "precio");
    if (!PRECIOS.includes(precio)) {
      throw Object.assign(new Error("El precio debe ser €, €€ o €€€."), { code: "VALIDATION_ERROR" });
    }
    const categorias = Array.isArray(a.categorias) ? a.categorias.map((c) => String(c || "").trim()).filter(Boolean) : [];
    if (!categorias.length) {
      throw Object.assign(new Error("Indica al menos una cocina (separadas por comas)."), {
        code: "VALIDATION_ERROR",
      });
    }

    return negociosService.proponerNegocio({
      uid,
      email: ctx.user.email || "",
      datos: {
        nombre,
        ciudad,
        zona,
        direccion,
        precio,
        categorias,
        telefono: String(a.telefono || "").trim(),
        descripcion: String(a.descripcion || "").trim(),
      },
    });
  },

  listMyNegocios: async (ctx, args) => {
    const uid = requireUid(ctx);
    const list = (await negociosService.listarMisNegocios(uid)) || [];
    return list.slice(0, MAX_ITEMS);
  },
};
