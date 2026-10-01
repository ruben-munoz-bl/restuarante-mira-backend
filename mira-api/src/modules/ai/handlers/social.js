"use strict";

const reviewsService = require("../../reviews/service");
const invitationsService = require("../../invitations/service");
const ticketsService = require("../../tickets/service");

const MAX_ITEMS = 50;

const nombreUsuario = (user) => user.nombre || user.displayName || user.email || "";

module.exports = {
  getUserReviews: async (ctx, args) => {
    const list = await reviewsService.listarResenasDeUsuario(ctx.user.uid);
    return (list || []).slice(0, MAX_ITEMS);
  },

  createReview: async (ctx, args) => {
    const a = args || {};
    const puntuacion = Number(a.puntuacion);
    if (!Number.isInteger(puntuacion) || puntuacion < 1 || puntuacion > 5) {
      throw Object.assign(new Error("Puntuación 1-5."), { code: "VALIDATION_ERROR" });
    }
    const comentario = String(a.comentario || "").trim();
    if (!comentario) {
      throw Object.assign(new Error("Escribe un comentario."), { code: "VALIDATION_ERROR" });
    }
    const id = await reviewsService.crearResena({
      restauranteId: a.restauranteId,
      uid: ctx.user.uid,
      usuarioNombre: nombreUsuario(ctx.user),
      puntuacion,
      comentario,
    });
    return { id, reviewId: id };
  },

  likeReview: async (ctx, args) => {
    await reviewsService.darLike(args.resenaId, ctx.user.uid);
    return { ok: true, resenaId: args.resenaId };
  },

  unlikeReview: async (ctx, args) => {
    await reviewsService.quitarLike(args.resenaId, ctx.user.uid);
    return { ok: true, resenaId: args.resenaId };
  },

  inviteMy: async (ctx, args) => {
    const result = await invitationsService.getMyInvites(ctx.user.uid);
    if (!result) return result;
    const enviadas = (result.enviadas || []).slice(0, MAX_ITEMS);
    return { ...result, enviadas, invitaciones: enviadas };
  },

  createInvite: async (ctx, args) => {
    const email = String((args || {}).email || "").trim();
    if (!email) {
      throw Object.assign(new Error("Email requerido."), { code: "VALIDATION_ERROR" });
    }
    return invitationsService.crearInvitacion(ctx.user.uid, email);
  },

  acceptInvite: async (ctx, args) => {
    const codigo = String((args || {}).codigo || "").trim();
    if (!codigo) {
      throw Object.assign(new Error("Código de invitación requerido."), { code: "VALIDATION_ERROR" });
    }
    return invitationsService.aceptarInvitacion(codigo, ctx.user.uid, ctx.user.email);
  },

  listTickets: async (ctx, args) => {
    const raw = parseInt((args || {}).limit, 10);
    const limit = Math.min(Math.max(raw || 20, 1), 100);
    const list = await ticketsService.getTicketsByUser(ctx.user.uid, { page: 1, limit });
    return (list || []).slice(0, MAX_ITEMS);
  },

  getTicket: async (ctx, args) => {
    return ticketsService.getTicket((args || {}).ticketId, ctx.user.uid, ctx.user.role);
  },
};