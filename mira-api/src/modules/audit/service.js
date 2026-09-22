const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function logAudit({ actorUid, accion, entidad, entidadId, diff, ip }) {
  try {
    await db.collection("auditLog").add({
      actorUid: actorUid || "system",
      accion,
      entidad,
      entidadId,
      diff: diff || {},
      ip: ip || null,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.error({ err, accion, entidad, entidadId }, "Audit log failed");
  }
}

module.exports = { logAudit };
