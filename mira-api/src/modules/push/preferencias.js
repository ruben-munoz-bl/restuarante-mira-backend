const { z } = require("zod");
const { db } = require("../../middlewares/verifyFirebaseAuth");

const tipoPushSchema = z.enum(["reservas", "mensajes", "promociones"]);
const cambioPreferenciasSchema = z.object({
  reservas: z.boolean().optional(),
  mensajes: z.boolean().optional(),
  promociones: z.boolean().optional(),
}).strict().refine(datos => Object.keys(datos).length > 0, { message: "Indica al menos una preferencia" });

// Reservas/mensajes mantienen su valor previo; promociones exige true explícito.
function normalizarPreferencias(datos) {
  return {
    reservas: datos?.reservas !== false,
    mensajes: datos?.mensajes !== false,
    promociones: datos?.promociones === true,
  };
}

async function leerPreferencias(uid) {
  const snap = await db.collection("usuarios").doc(uid).get();
  return normalizarPreferencias(snap.exists ? snap.data().preferenciasPush : null);
}

async function guardarPreferencias(uid, cambios) {
  const ref = db.collection("usuarios").doc(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const anteriores = normalizarPreferencias(snap.exists ? snap.data().preferenciasPush : null);
    const preferenciasPush = { ...anteriores, ...cambios };
    tx.set(ref, { preferenciasPush }, { merge: true });
    return preferenciasPush;
  });
}

module.exports = { tipoPushSchema, cambioPreferenciasSchema, leerPreferencias, guardarPreferencias };
