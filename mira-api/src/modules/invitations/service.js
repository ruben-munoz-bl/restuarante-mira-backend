const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { generarInviteCode, INVITACIONES_MAX_MES, INVITACIONES_RESERVAS_REQUERIDAS, PUNTOS_INVITACION } = require("../../config/constants");

const { enviarInvitacion } = require("./mailer");

async function crearInvitacion(uid, emailInvitado) {
  emailInvitado = String(emailInvitado || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInvitado)) {
    const error = new Error("No existe la dirección, compruebe antes de volver a enviar");
    error.status = 400;
    throw error;
  }
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
    emailEstado: "no_enviado",
    messageId: null,
    reservasAmigo: 0,
    aceptadaPor: null,
    aceptadaEn: null,
    createdAt: new Date(),
  });

  const envio = await enviarInvitacion({ email: emailInvitado, codigo });
  const ref = db.collection("invitaciones").doc(docRef.id);
  const emailEstado = await db.runTransaction(async (tx) => {
    const actual = await tx.get(ref);
    // Un webhook rápido puede haber marcado el rebote mientras Brevo respondía.
    const estado = actual.data()?.emailEstado === "inexistente" ? "inexistente" : envio.emailEstado;
    tx.update(ref, { ...envio, emailEstado: estado });
    return estado;
  });
  logger.info({ uid, inviteId: docRef.id }, "Invitation created");
  return { id: docRef.id, codigo, email: emailInvitado, estado: "pendiente", messageId: envio.messageId, emailEstado };
}

async function aceptarInvitacion(codigo, uid, userEmail) {
  const inviteSnap = await db.collection("invitaciones").where("codigo", "==", codigo).limit(1).get();
  if (inviteSnap.empty) throw new Error("Código no válido");
  const inviteDoc = inviteSnap.docs[0];
  const resultado = await db.runTransaction(async (tx) => {
    const actual = await tx.get(db.collection("invitaciones").doc(inviteDoc.id));
    const inv = actual.data();
    const aceptacionRef = db.collection("invitaciones_aceptadas").doc(uid);
    const previa = await tx.get(aceptacionRef);
    if (!userEmail || inv.creadorUid === uid ||
        inv.emailInvitado.toLowerCase() !== String(userEmail).toLowerCase()) {
      throw new Error("Este código no es para ti");
    }
    if (inv.aceptadaPor === uid && inv.estado !== "pendiente") {
      return { ok: true, creadorUid: inv.creadorUid, estado: inv.estado };
    }
    if (inv.estado !== "pendiente" || previa.exists) throw new Error("Invitación ya usada");
    tx.update(db.collection("invitaciones").doc(inviteDoc.id), {
      estado: "esperando_2_reservas", aceptadaPor: uid,
      aceptadaEn: new Date(), updatedAt: new Date(),
    });
    tx.set(aceptacionRef, { invitacionId: inviteDoc.id, createdAt: new Date() });
    return { ok: true, creadorUid: inv.creadorUid, estado: "esperando_2_reservas" };
  });
  return resultado;
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
  const enviadasSnap = await db.collection("invitaciones").where("creadorUid", "==", uid).get();
  const enviadas = enviadasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const fecha = (v) => v?.toDate ? v.toDate().getTime() : new Date(v).getTime();
  enviadas.sort((a, b) => fecha(b.createdAt) - fecha(a.createdAt));
  const aceptadas = enviadas.filter((inv) => inv.estado === "aceptada").length;
  return { enviadas, aceptadas, puntosTotales: aceptadas * PUNTOS_INVITACION, invitaciones: enviadas };
}

const EVENTOS_INEXISTENTE = new Set(["hard_bounce", "invalid_email", "blocked"]);

async function procesarEventoBrevo(evento) {
  if (!EVENTOS_INEXISTENTE.has(evento.event)) return;
  let invitacion;
  if (evento["message-id"]) {
    // Brevo puede emitir el identificador con o sin los corchetes angulares de la respuesta HTTP.
    const id = evento["message-id"].trim();
    const sinCorchetes = id.replace(/^<|>$/g, "");
    for (const candidato of new Set([id, sinCorchetes, `<${sinCorchetes}>`])) {
      const snap = await db.collection("invitaciones").where("messageId", "==", candidato).limit(1).get();
      if (snap.docs[0]) { invitacion = snap.docs[0]; break; }
    }
  }
  if (!invitacion && evento.email) {
    const email = evento.email.trim().toLowerCase();
    const snap = await db.collection("invitaciones").where("emailInvitado", "==", email).get();
    const fecha = (v) => v?.toDate ? v.toDate().getTime() : new Date(v).getTime() || 0;
    invitacion = snap.docs.filter((d) => d.data().estado === "pendiente" && !d.data().aceptadaPor)
      .sort((a, b) => fecha(b.data().createdAt) - fecha(a.data().createdAt))[0];
  }
  if (!invitacion) return;
  const ref = db.collection("invitaciones").doc(invitacion.id);
  await db.runTransaction(async (tx) => {
    const actual = await tx.get(ref);
    const datos = actual.data();
    // Ni las aceptadas ni las que esperan reservas se modifican; también protege carreras con /accept.
    if (!actual.exists || datos.estado !== "pendiente" || datos.aceptadaPor) return;
    tx.update(ref, { emailEstado: "inexistente" });
  });
}

module.exports = { procesarEventoBrevo, EVENTOS_INEXISTENTE, crearInvitacion, aceptarInvitacion, onInvitadoReservaCompletada, getMyInvites };
