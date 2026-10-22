const { createHmac, timingSafeEqual } = require("crypto");
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { env } = require("../../config/env");
const { comprobarRestaurante } = require("../../middlewares/ownership");
const { hoyMadrid } = require("../ofertas/logica");
const { error } = require("../visitas/logica");

function secretoQr() {
  const secreto = env.RESERVAS_QR_SECRET || env.VISITAS_SECRET;
  if (typeof secreto !== "string" || secreto.length < 32) throw error(503, "RESERVAS_QR_NO_CONFIGURADO", "QR de reservas no configurado");
  return secreto;
}
function firmarQrReserva(id) {
  return `r1.${id}.${createHmac("sha256", secretoQr()).update(`r1.${id}`).digest("base64url")}`;
}
function leerQrReserva(qr) {
  const secreto = secretoQr();
  const partes = /^r1\.([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(qr);
  if (!partes) throw error(400, "QR_INVALIDO", "QR inválido");
  const [, id, firma] = partes;
  const recibida = Buffer.from(firma, "base64url");
  const esperada = createHmac("sha256", secreto).update(`r1.${id}`).digest();
  if (recibida.length !== esperada.length || recibida.toString("base64url") !== firma || !timingSafeEqual(recibida, esperada)) {
    throw error(400, "QR_INVALIDO", "QR inválido");
  }
  return id;
}
function paraCliente(reserva) {
  let qr = null;
  if (reserva.estado !== "cancelada" && !reserva.presentadaEn && reserva.fecha >= hoyMadrid()) {
    try { qr = firmarQrReserva(reserva.id); }
    catch (err) { if (err.code !== "RESERVAS_QR_NO_CONFIGURADO") throw err; }
  }
  return { ...reserva, pedido: reserva.pedido ?? null, presentadaEn: reserva.presentadaEn ?? null, qr };
}
async function checkin(qr, user) {
  const id = leerQrReserva(qr);
  const ref = db.collection("reservas").doc(id);
  const previa = await ref.get();
  if (!previa.exists) throw error(404, "NOT_FOUND", "Reserva no encontrada");
  const restauranteId = previa.data().restaurantId || previa.data().restauranteId;
  try { await comprobarRestaurante(restauranteId, user); }
  catch (err) {
    if (err.status === 403) throw error(403, "OTRO_RESTAURANTE", "Reserva de otro restaurante");
    throw err;
  }
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw error(404, "NOT_FOUND", "Reserva no encontrada");
    const d = snap.data();
    if ((d.restaurantId || d.restauranteId) !== restauranteId) throw error(403, "OTRO_RESTAURANTE", "Reserva de otro restaurante");
    if (d.presentadaEn) throw error(409, "QR_USADO", "Reserva ya presentada");
    if (d.estado === "cancelada") throw error(409, "RESERVA_CANCELADA", "Reserva cancelada");
    const ahora = new Date();
    if (d.fecha !== hoyMadrid(ahora)) throw error(409, "FUERA_DE_FECHA", "No es el día de la reserva");
    const perfilRef = db.collection("usuarios").doc(d.uid);
    const perfil = await tx.get(perfilRef);
    const puntosPedido = d.pedido?.lineas?.length ? 50 : 0;
    const movimiento = db.collection("puntos_movimientos").doc(`pedido_anticipado_${id}`);
    if (puntosPedido) {
      if (!perfil.exists) throw error(404, "NOT_FOUND", "Cliente no encontrado");
      const anterior = await tx.get(movimiento);
      if (anterior.exists) throw error(409, "QR_USADO", "Pedido ya premiado");
    }
    const presentadaEn = ahora.toISOString();
    // Todas las lecturas antes de escribir. Marcador y saldo se confirman juntos;
    // reintentos concurrentes leen presentadaEn y no vuelven a sumar.
    tx.update(ref, { presentadaEn, puntosPedido, updatedAt: ahora });
    const cliente = perfil.exists ? perfil.data() : {};
    if (puntosPedido) {
      tx.update(perfilRef, { saldoPuntos: (cliente.saldoPuntos || 0) + 50,
        totalAcumulado: (cliente.totalAcumulado || 0) + 50, updatedAt: ahora });
      tx.set(movimiento, { uid: d.uid, tipo: "pedido_anticipado", puntos: 50,
        descripcion: "Pedido anticipado: llegada al restaurante", reservaId: id, restauranteId, createdAt: ahora });
    }
    return { reserva: { id, codigo: d.codigo, fecha: d.fecha, hora: d.hora, comensales: d.comensales,
      presentadaEn, pedido: d.pedido ?? null }, cliente: { nombre: typeof cliente.nombre === "string" ? cliente.nombre : "" }, puntosPedido };
  });
}
module.exports = { firmarQrReserva, leerQrReserva, paraCliente, checkin };
