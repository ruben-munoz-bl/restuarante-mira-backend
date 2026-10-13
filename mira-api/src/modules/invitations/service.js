const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { generarInviteCode, INVITACIONES_MAX_MES, INVITACIONES_RESERVAS_REQUERIDAS, PUNTOS_INVITACION } = require("../../config/constants");

async function crearInvitacion(uid, emailInvitado) {
  const userSnap = await db.collection("usuarios").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};

  if (emailInvitado.toLowerCase() === (userData.email || "").toLowerCase()) {
    throw new Error("No puedes invitarte a ti mismo");
  }

  const snap = await db.collection("invitaciones").where("creadorUid", "==", uid).get();
  const now = new Date();
  const thisMonth = snap.docs.filter((d) => {
    const c = d.data().createdAt?.toDate ? d.data().createdAt.toDate() : new Date(d.data().createdAt);
    return c.getMonth() === now.getMonth() && c.getFullYear() === now.getFullYear();
  });
  if (thisMonth.length >= INVITACIONES_MAX_MES) {
    throw new Error(`Límite de ${INVITACIONES_MAX_MES} invitaciones por mes`);
  }

  const codigo = generarInviteCode();
  const docRef = await db.collection("invitaciones").add({
    creadorUid: uid,
    emailInvitado: emailInvitado,
    codigo,
    estado: "pendiente",
    reservasAmigo: 0,
    aceptadaPor: null,
    aceptadaEn: null,
    createdAt: new Date(),
  });

  logger.info({ uid, emailInvitado, inviteId: docRef.id }, "Invitation created");
  return { id: docRef.id, codigo, email: emailInvitado, estado: "pendiente" };
}

async function aceptarInvitacion(codigo, uid, userEmail) {
  const inviteSnap = await db.collection("invitaciones").where("codigo", "==", codigo).limit(1).get();
  if (inviteSnap.empty) throw new Error("Código no válido");
  const inviteDoc = inviteSnap.docs[0];
  const inv = inviteDoc.data();

  if (inv.emailInvitado && userEmail && inv.emailInvitado.toLowerCase() !== String(userEmail).toLowerCase()) {
    throw new Error("Este código no es para ti");
  }
  if (inv.estado !== "pendiente") throw new Error("Invitación ya usada");

  await db.collection("invitaciones").doc(inviteDoc.id).update({
    estado: "esperando_2_reservas",
    aceptadaPor: uid,
    aceptadaEn: new Date(),
    updatedAt: new Date(),
  });

  logger.info({ inviteId: inviteDoc.id, uid }, "Invitation accepted (waiting for 2 reservations)");
  return { ok: true, creadorUid: inv.creadorUid, estado: "esperando_2_reservas" };
}

async function onInvitadoReservaCompletada(invitadoUid, reservaId) {
  if (!reservaId) return;
  const snap = await db.collection("invitaciones")
    .where("aceptadaPor", "==", invitadoUid)
    .where("estado", "==", "esperando_2_reservas").limit(1).get();
  if (snap.empty) return;
  const inviteRef = db.collection("invitaciones").doc(snap.docs[0].id);
  await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    const inv = inviteSnap.data();
    if (!inv || inv.estado !== "esperando_2_reservas") return;
    const contadas = inv.reservasContadas || [];
    if (contadas.includes(reservaId)) return;
    const nuevasReservas = (inv.reservasAmigo || 0) + 1;
    const premiar = nuevasReservas >= INVITACIONES_RESERVAS_REQUERIDAS;
    const usuarios = [];
    if (premiar) {
      for (const uid of [inv.creadorUid, invitadoUid]) {
        const ref = db.collection("usuarios").doc(uid);
        const user = await tx.get(ref);
        if (!user.exists) throw new Error("Usuario de invitación no encontrado");
        usuarios.push({ uid, ref, datos: user.data() });
      }
    }
    tx.update(inviteRef, {
      reservasAmigo: nuevasReservas,
      reservasContadas: [...contadas, reservaId],
      estado: premiar ? "aceptada" : "esperando_2_reservas",
      updatedAt: new Date(),
    });
    for (const { uid, ref, datos } of usuarios) {
      tx.update(ref, {
        saldoPuntos: (datos.saldoPuntos || 0) + PUNTOS_INVITACION,
        totalAcumulado: (datos.totalAcumulado || 0) + PUNTOS_INVITACION,
        updatedAt: new Date(),
      });
      tx.set(db.collection("puntos_movimientos").doc(), {
        uid, tipo: "invitacion", puntos: PUNTOS_INVITACION,
        descripcion: "Invitación completada (2 reservas del amigo)", createdAt: new Date(),
      });
    }
  });
}

async function getMyInvites(uid) {
  const enviadasSnap = await db.collection("invitaciones").where("creadorUid", "==", uid).orderBy("createdAt", "desc").get();
  const enviadas = enviadasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const aceptadas = enviadas.filter((inv) => inv.estado === "aceptada").length;
  return { enviadas, aceptadas, puntosTotales: aceptadas * PUNTOS_INVITACION, invitaciones: enviadas };
}

module.exports = { crearInvitacion, aceptarInvitacion, onInvitadoReservaCompletada, getMyInvites };
