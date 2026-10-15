const { createHash } = require("crypto");
const { Expo } = require("expo-server-sdk");
const { z } = require("zod");
const { db, admin } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

const { env } = require("../../config/env");

const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN || undefined });
const notificacionSchema = z.object({
  titulo: z.string().min(1).max(200),
  cuerpo: z.string().min(1).max(2000),
  data: z.record(z.string()).default({}),
}).strict();
const MAX_DISPOSITIVOS = 10;
const ESPERA_RECIBO = 15 * 60 * 1000;
const CADUCIDAD_RECIBO = 24 * 60 * 60 * 1000;

function dispositivos(uid) {
  return db.collection(`usuarios/${uid}/dispositivos`);
}

async function registrarToken(uid, { token, tipo, plataforma, idioma }) {
  const id = createHash("sha256").update(`${tipo}:${token}`).digest("hex");
  const propios = dispositivos(uid);
  const ref = propios.doc(id);
  const coincidencias = db.collectionGroup("dispositivos").where("tokenHash", "==", id);
  // Reasignación y cupo atómicos: nunca confirmar el alta dejando copias en otra cuenta.
  await db.runTransaction(async tx => {
    const anteriores = await tx.get(coincidencias);
    const actuales = await tx.get(propios);
    for (const doc of anteriores.docs) {
      if (doc.ref.path !== ref.path) tx.delete(doc.ref);
    }
    // Excluir el que se registra de nuevo: se conserva como el más reciente,
    // incluso cuando varias altas comparten el mismo milisegundo.
    const otros = actuales.docs.filter(doc => doc.id !== id).sort((a, b) => {
      const orden = (a.data().actualizado || "").localeCompare(b.data().actualizado || "");
      return orden || a.id.localeCompare(b.id);
    });
    for (const doc of otros.slice(0, Math.max(0, otros.length - MAX_DISPOSITIVOS + 1))) {
      tx.delete(propios.doc(doc.id));
    }
    tx.set(ref, { token, tokenHash: id, tipo, plataforma, idioma, actualizado: new Date().toISOString() });
  });
  return { id, tipo, plataforma, idioma };
}

async function borrarToken(uid, id) {
  await dispositivos(uid).doc(id).delete();
}

// Aceptado por el proveedor no significa que el dispositivo lo haya mostrado.
// Los errores se aíslan por dispositivo y nunca se registran tokens ni mensajes.
async function enviarPush(uid, notificacion) {
  const { titulo, cuerpo, data } = notificacionSchema.parse(notificacion);
  const snapshot = await dispositivos(uid).get();
  const resultado = { enviados: 0, fallidos: 0, eliminados: 0 };
  for (const doc of snapshot.docs) {
    const dispositivo = doc.data();
    try {
      if (dispositivo.tipo === "expo") {
        const [ticket] = await expo.sendPushNotificationsAsync([{
          to: dispositivo.token, title: titulo, body: cuerpo, data, sound: "default",
        }]);
        if (ticket.status === "error") {
          if (ticket.details?.error === "DeviceNotRegistered") {
            await borrarToken(uid, doc.id);
            resultado.eliminados++;
          }
          resultado.fallidos++;
          continue;
        }
        // Persistir antes de devolver: sobrevive a reinicios y al reposo de Render.
        const ahora = Date.now();
        await db.collection("push_recibos").doc(ticket.id).set({
          uid, dispositivoId: doc.id, creado: ahora, revisarDesde: ahora + ESPERA_RECIBO,
        });
      } else if (dispositivo.tipo === "web") {
        await admin.messaging().send({
          token: dispositivo.token, notification: { title: titulo, body: cuerpo }, data,
        });
      } else {
        resultado.fallidos++;
        continue;
      }
      resultado.enviados++;
    } catch (err) {
      if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(err.code)) {
        await borrarToken(uid, doc.id);
        resultado.eliminados++;
      }
      resultado.fallidos++;
      logger.warn({ canal: dispositivo.tipo }, "No se pudo enviar push");
    }
  }
  return resultado;
}

async function revisarRecibos() {
  const ahora = Date.now();
  const pendientes = await db.collection("push_recibos").where("revisarDesde", "<=", ahora).limit(200).get();
  if (pendientes.empty) return;
  const recibos = await expo.getPushNotificationReceiptsAsync(pendientes.docs.map(doc => doc.id));
  for (const doc of pendientes.docs) {
    const pendiente = doc.data();
    const recibo = recibos[doc.id];
    if (recibo?.details?.error === "DeviceNotRegistered") {
      await borrarToken(pendiente.uid, pendiente.dispositivoId);
    }
    const ref = db.collection("push_recibos").doc(doc.id);
    if (recibo || ahora - pendiente.creado >= CADUCIDAD_RECIBO) {
      await ref.delete();
    } else {
      await ref.update({ revisarDesde: ahora + ESPERA_RECIBO });
    }
  }
}

module.exports = { registrarToken, borrarToken, enviarPush, revisarRecibos };
