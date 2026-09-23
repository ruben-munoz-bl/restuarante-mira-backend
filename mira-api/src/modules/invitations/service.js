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

async function onInvitadoReservaCompletada(invitadoUid) {
  const inviteSnap = await db.collection("invitaciones")
    .where("aceptadaPor", "==", invitadoUid)
    .where("estado", "==", "esperando_2_reservas")
    .limit(1)
    .get();

  if (inviteSnap.empty) return;

  const inviteDoc = inviteSnap.docs[0];
  const inv = inviteDoc.data();
  const nuevasReservas = (inv.reservasAmigo || 0) + 1;

  if (nuevasReservas >= INVITACIONES_RESERVAS_REQUERIDAS) {
    await db.runTransaction(async (tx) => {
      tx.update(db.collection("invitaciones").doc(inviteDoc.id), {
        reservasAmigo: nuevasReservas,
        estado: "aceptada",
        updatedAt: new Date(),
      });

      const userRef = db.collection("usuarios").doc(inv.creadorUid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;
      const userData = userSnap.data();
      const nuevoSaldo = (userData.saldoPuntos || 0) + PUNTOS_INVITACION;

      tx.update(userRef, {
        saldoPuntos: nuevoSaldo,
        totalAcumulado: (userData.totalAcumulado || 0) + PUNTOS_INVITACION,
        updatedAt: new Date(),
      });

      const movRef = db.collection("puntos_movimientos").doc();
      tx.set(movRef, {
        uid: inv.creadorUid,
        tipo: "invitacion",
        puntos: PUNTOS_INVITACION,
        descripcion: "Invitación completada (2 reservas del amigo)",
        createdAt: new Date(),
      });
    });

    logger.info({ creadorUid: inv.creadorUid, invitadoUid, puntos: PUNTOS_INVITACION }, "Invitation reward granted");
  } else {
    await db.collection("invitaciones").doc(inviteDoc.id).update({
      reservasAmigo: nuevasReservas,
    });
  }
}

async function getMyInvites(uid) {
  const [enviadasSnap, aceptadasSnap] = await Promise.all([
    db.collection("invitaciones").where("creadorUid", "==", uid).orderBy("createdAt", "desc").get(),
    db.collection("invitaciones").where("aceptadaPor", "==", uid).get(),
  ]);
  const enviadas = enviadasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const aceptadas = aceptadasSnap.size;
  return { enviadas, aceptadas, invitaciones: enviadas };
}

module.exports = { crearInvitacion, aceptarInvitacion, onInvitadoReservaCompletada, getMyInvites };
