const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { generarInviteCode, inicioMes, INVITACIONES_MAX_MES, INVITACIONES_RESERVAS_REQUERIDAS, PUNTOS_INVITACION } = require("../../config/constants");
const { addMovement } = require("../points/service");

async function crearInvitacion(uid, emailInvitado) {
  const userSnap = await db.collection("usuarios").doc(uid).get();
  if (!userSnap.exists) throw new Error("Usuario no encontrado");
  const userData = userSnap.data();

  if (emailInvitado.toLowerCase() === (userData.email || "").toLowerCase()) {
    throw new Error("No puedes invitarte a ti mismo");
  }

  const mesActual = inicioMes();
  const invitesSnap = await db.collection("invitaciones")
    .where("invitadorUid", "==", uid)
    .where("createdAt", ">=", new Date(mesActual))
    .get();
  if (invitesSnap.size >= INVITACIONES_MAX_MES) {
    throw new Error(`Máximo ${INVITACIONES_MAX_MES} invitaciones por mes`);
  }

  const existingInvite = await db.collection("invitaciones")
    .where("invitadorUid", "==", uid)
    .where("invitadoEmail", "==", emailInvitado.toLowerCase())
    .get();
  if (!existingInvite.empty) throw new Error("Ya enviaste invitación a este email");

  const codigo = generarInviteCode();
  const docRef = await db.collection("invitaciones").add({
    invitadorUid: uid,
    invitadoEmail: emailInvitado.toLowerCase(),
    invitadoUid: null,
    codigo,
    estado: "pendiente",
    contadorReservasInvitado: 0,
    createdAt: new Date(),
    aceptadaAt: null,
  });

  logger.info({ uid, emailInvitado, inviteId: docRef.id }, "Invitation created");
  return { id: docRef.id, codigo, link: `https://mira.vercel.app/#/registro?invite=${codigo}` };
}

async function aceptarInvitacion(codigo, invitadoUid) {
  const inviteSnap = await db.collection("invitaciones").where("codigo", "==", codigo).limit(1).get();
  if (inviteSnap.empty) throw new Error("Invitación no encontrada");
  const inviteDoc = inviteSnap.docs[0];
  const invite = inviteDoc.data();

  if (invite.estado === "aceptada") throw new Error("Invitación ya utilizada");
  if (invite.invitadoUid && invite.invitadoUid !== invitadoUid) throw new Error("Invitación asignada a otro usuario");

  await db.collection("invitaciones").doc(inviteDoc.id).update({
    invitadoUid,
    estado: "esperando_2_reservas",
    updatedAt: new Date(),
  });

  logger.info({ inviteId: inviteDoc.id, invitadoUid }, "Invitation accepted (waiting for 2 reservations)");
  return { aceptada: true };
}

async function onInvitadoReservaCompletada(invitadoUid) {
  const inviteSnap = await db.collection("invitaciones")
    .where("invitadoUid", "==", invitadoUid)
    .where("estado", "==", "esperando_2_reservas")
    .limit(1)
    .get();

  if (inviteSnap.empty) return;

  const inviteDoc = inviteSnap.docs[0];
  const invite = inviteDoc.data();

  const nuevoContador = (invite.contadorReservasInvitado || 0) + 1;

  if (nuevoContador >= INVITACIONES_RESERVAS_REQUERIDAS) {
    await db.runTransaction(async (tx) => {
      tx.update(db.collection("invitaciones").doc(inviteDoc.id), {
        contadorReservasInvitado: nuevoContador,
        estado: "aceptada",
        aceptadaAt: new Date(),
      });

      const userRef = db.collection("usuarios").doc(invite.invitadorUid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;
      const userData = userSnap.data();
      const nuevoSaldo = (userData.saldoPuntos || 0) + PUNTOS_INVITACION;

      tx.update(userRef, {
        saldoPuntos: nuevoSaldo,
        totalAcumulado: (userData.totalAcumulado || 0) + PUNTOS_INVITACION,
        updatedAt: new Date(),
      });

      const movRef = db.collection("movimientos").doc();
      tx.set(movRef, {
        uid: invite.invitadorUid,
        tipo: "invitacion",
        cantidad: PUNTOS_INVITACION,
        saldoResultante: nuevoSaldo,
        referenciaTipo: "invitacion",
        referenciaId: inviteDoc.id,
        createdAt: new Date(),
      });
    });

    logger.info({ invitadorUid: invite.invitadorUid, invitadoUid, puntos: PUNTOS_INVITACION }, "Invitation reward granted");
  } else {
    await db.collection("invitaciones").doc(inviteDoc.id).update({
      contadorReservasInvitado: nuevoContador,
    });
  }
}

async function getMyInvites(uid) {
  const snap = await db.collection("invitaciones").where("invitadorUid", "==", uid).orderBy("createdAt", "desc").get();
  const enviadas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const aceptadas = enviadas.filter((i) => i.estado === "aceptada").length;
  const puntosTotales = aceptadas * PUNTOS_INVITACION;
  return { enviadas, aceptadas, puntosTotales };
}

module.exports = { crearInvitacion, aceptarInvitacion, onInvitadoReservaCompletada, getMyInvites };
