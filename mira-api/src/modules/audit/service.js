/**
 * Compatibilidad: logAudit() escribía en `auditLog`. Ahora delega en el store
 * único de auditoría (`auditoria`) para no tener dos historiales paralelos.
 */
const { registrarServidor } = require("../auditoria/service");

async function logAudit({ actorUid, accion, entidad, entidadId, diff }) {
  const cambios = diff && typeof diff === "object"
    ? Object.entries(diff).map(([campo, v]) => ({ campo, antes: v?.antes ?? null, despues: v?.despues ?? v ?? null }))
    : null;
  await registrarServidor(actorUid ? { user: { uid: actorUid }, headers: {} } : null, {
    tipo: "interaccion", origen: "api", accion, entidadTipo: entidad, entidadId, cambios,
  });
}

module.exports = { logAudit };
