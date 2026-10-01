"use strict";

const pointsService = require("../../points/service");
const dailyLogin = require("../../points/dailyLogin");

const DEFAULT_LEDGER_LIMIT = 20;
const MAX_LEDGER_LIMIT = 100;

function requireUid(ctx) {
  const uid = ctx && ctx.user ? ctx.user.uid : null;
  if (!uid) {
    throw Object.assign(new Error("Inicia sesión para usar esta función."), { code: "MISSING_TOKEN" });
  }
  return uid;
}

module.exports = {
  getLedger: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const rawLimit = Number(a.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LEDGER_LIMIT)
      : DEFAULT_LEDGER_LIMIT;
    return pointsService.getLedger(uid, { tipo: a.tipo || null, limit });
  },

  redeemPoints: async (ctx, args) => {
    const uid = requireUid(ctx);
    const a = args || {};
    const puntos = Number(a.puntos);
    if (!Number.isInteger(puntos) || puntos <= 0) {
      throw Object.assign(new Error("Los puntos a canjear deben ser un entero mayor que 0."), {
        code: "VALIDATION_ERROR",
      });
    }
    return pointsService.redeem(uid, puntos);
  },

  dailyLogin: async (ctx, args) => {
    const uid = requireUid(ctx);
    return dailyLogin.reclamarLoginDiario(uid);
  },

  spinWheel: async (ctx, args) => {
    const uid = requireUid(ctx);
    return pointsService.claimWheelReward(uid, { force: false });
  },
};