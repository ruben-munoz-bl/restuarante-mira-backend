const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");

async function getRestaurantDashboard(restaurantId) {
  const restSnap = await db.collection("restaurants").doc(restaurantId).get();
  if (!restSnap.exists) throw new Error("Restaurante no encontrado");
  const restaurante = { id: restSnap.id, ...restSnap.data() };

  const reservasSnap = await db.collection("reservas")
    .where("restaurantId", "==", restaurantId)
    .orderBy("fecha", "desc")
    .limit(500)
    .get();
  const reservas = reservasSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const ticketsSnap = await db.collection("tickets")
    .where("restaurantId", "==", restaurantId)
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();
  const tickets = ticketsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const totalReservas = reservas.length;
  const reservasCompletadas = reservas.filter(r => r.estado === "completada").length;
  const reservasCanceladas = reservas.filter(r => r.estado === "cancelada").length;
  const reservasNoShow = reservas.filter(r => r.estado === "no_show").length;
  const reservasPendientes = reservas.filter(r => r.estado === "confirmada" || r.estado === "pendiente").length;

  const totalFacturacion = tickets.reduce((sum, t) => sum + (t.totalPagado || 0), 0);
  const totalComisiones = tickets.reduce((sum, t) => sum + (t.importeComision || 0), 0);

  const hoy = new Date().toISOString().split("T")[0];
  const reservasHoy = reservas.filter(r => r.fecha === hoy && r.estado !== "cancelada");

  const proximasReservas = reservas
    .filter(r => r.fecha >= hoy && (r.estado === "confirmada" || r.estado === "pendiente"))
    .sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`))
    .slice(0, 20);

  const ingresosPorMes = {};
  tickets.forEach(t => {
    const fecha = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
    if (!ingresosPorMes[mes]) ingresosPorMes[mes] = { facturacion: 0, comisiones: 0, tickets: 0 };
    ingresosPorMes[mes].facturacion += t.totalPagado || 0;
    ingresosPorMes[mes].comisiones += t.importeComision || 0;
    ingresosPorMes[mes].tickets += 1;
  });

  return {
    restaurante,
    stats: {
      totalReservas,
      reservasCompletadas,
      reservasCanceladas,
      reservasNoShow,
      reservasPendientes,
      reservasHoy: reservasHoy.length,
      totalFacturacion: Math.round(totalFacturacion * 100) / 100,
      totalComisiones: Math.round(totalComisiones * 100) / 100,
      ticketPromedio: tickets.length > 0 ? Math.round(totalFacturacion / tickets.length * 100) / 100 : 0,
    },
    proximasReservas,
    ingresosPorMes,
    ticketsRecientes: tickets.slice(0, 20),
  };
}

async function getAdminDashboard() {
  const [usersSnap, reservasSnap, ticketsSnap, promosSnap] = await Promise.all([
    db.collection("usuarios").get(),
    db.collection("reservas").orderBy("createdAt", "desc").limit(2000).get(),
    db.collection("tickets").orderBy("createdAt", "desc").limit(2000).get(),
    db.collection("promociones").get(),
  ]);

  const totalUsuarios = usersSnap.size;
  const usuariosActivos = usersSnap.docs.filter(d => {
    const data = d.data();
    return data.tipo !== "admin";
  }).length;

  const reservas = reservasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const tickets = ticketsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const totalReservas = reservas.length;
  const reservasCompletadas = reservas.filter(r => r.estado === "completada").length;
  const reservasCanceladas = reservas.filter(r => r.estado === "cancelada").length;
  const reservasNoShow = reservas.filter(r => r.estado === "no_show").length;

  const totalFacturacion = tickets.reduce((sum, t) => sum + (t.totalPagado || 0), 0);
  const totalComisiones = tickets.reduce((sum, t) => sum + (t.importeComision || 0), 0);

  const reservasPorRestaurante = {};
  reservas.forEach(r => {
    const key = r.restaurantId || "unknown";
    if (!reservasPorRestaurante[key]) reservasPorRestaurante[key] = { nombre: r.nombreRestaurante, total: 0, completadas: 0, canceladas: 0, noShow: 0 };
    reservasPorRestaurante[key].total++;
    if (r.estado === "completada") reservasPorRestaurante[key].completadas++;
    if (r.estado === "cancelada") reservasPorRestaurante[key].canceladas++;
    if (r.estado === "no_show") reservasPorRestaurante[key].noShow++;
  });

  const facturacionPorMes = {};
  tickets.forEach(t => {
    const fecha = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
    if (!facturacionPorMes[mes]) facturacionPorMes[mes] = { facturacion: 0, comisiones: 0, tickets: 0, reservas: 0 };
    facturacionPorMes[mes].facturacion += t.totalPagado || 0;
    facturacionPorMes[mes].comisiones += t.importeComision || 0;
    facturacionPorMes[mes].tickets += 1;
  });

  reservas.forEach(r => {
    const fecha = r.createdAt?.toDate ? r.createdAt.toDate() : new Date(r.createdAt);
    const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
    if (facturacionPorMes[mes]) facturacionPorMes[mes].reservas++;
  });

  return {
    stats: {
      totalUsuarios,
      usuariosActivos,
      totalReservas,
      reservasCompletadas,
      reservasCanceladas,
      reservasNoShow,
      totalFacturacion: Math.round(totalFacturacion * 100) / 100,
      totalComisiones: Math.round(totalComisiones * 100) / 100,
      totalPromociones: promosSnap.size,
      promosActivas: promosSnap.docs.filter(d => d.data().estado === "activa").length,
    },
    reservasPorRestaurante,
    facturacionPorMes,
    ticketsRecientes: tickets.slice(0, 30),
  };
}

async function updateRestaurant(restaurantId, data) {
  const allowed = ["nombre", "direccion", "telefono", "email", "horarios", "activo", "ciudad", "zona", "precio", "cocina", "descripcion", "comisionPct"];
  const update = {};
  allowed.forEach(k => { if (data[k] !== undefined) update[k] = data[k]; });
  update.updatedAt = new Date();
  await db.collection("restaurants").doc(restaurantId).update(update);
  logger.info({ restaurantId, fields: Object.keys(update) }, "Restaurant updated");
  return { updated: true };
}

async function updateReservationStatus(reservaId, status, { uid, precioBase, ticketData } = {}) {
  const reservaRef = db.collection("reservas").doc(reservaId);
  const snap = await reservaRef.get();
  if (!snap.exists) throw new Error("Reserva no encontrada");
  const reserva = snap.data();

  const update = { estado: status, updatedAt: new Date() };
  const estabaCompletada = reserva.estado === "completada";
  await reservaRef.update(update);

  if (status === "completada" && !estabaCompletada) {
    try {
      const { generarTicket } = require("../tickets/service");
      await generarTicket(reservaId, { precioManual: precioBase, emitidoPor: "restaurante-simulado" });
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Ticket generation failed");
    }

    try {
      const { onInvitadoReservaCompletada } = require("../invitations/service");
      await onInvitadoReservaCompletada(reserva.uid);
    } catch (err) {
      logger.error({ reservaId, error: err.message }, "Invitation check failed");
    }
  }

  if (status === "no_show") {
    const aforoRef = db.collection("aforo").doc(`${reserva.restaurantId}_${reserva.fecha}_${reserva.hora}`);
    const aforoSnap = await aforoRef.get();
    if (aforoSnap.exists) {
      const ocupadas = aforoSnap.data().ocupadas || 0;
      await aforoRef.update({ ocupadas: Math.max(0, ocupadas - 1) });
    }
  }

  logger.info({ reservaId, status }, "Reservation status updated");
  return { updated: true, status };
}

async function addPointsManually(uid, cantidad, motivo, adminUid) {
  const { addMovement } = require("../points/service");
  const result = await addMovement(uid, "ajuste_admin", cantidad, {
    referenciaTipo: "admin_adjust",
    referenciaId: adminUid,
  });
  logger.info({ uid, cantidad, motivo, adminUid }, "Manual points adjustment");
  return result;
}

async function getAllUsers() {
  const snap = await db.collection("usuarios").get();
  return snap.docs.map(d => ({
    uid: d.id,
    nombre: d.data().nombre,
    email: d.data().email,
    tipo: d.data().tipo,
    saldoPuntos: d.data().saldoPuntos || 0,
    createdAt: d.data().createdAt,
  }));
}

module.exports = {
  getRestaurantDashboard,
  getAdminDashboard,
  updateRestaurant,
  updateReservationStatus,
  addPointsManually,
  getAllUsers,
};
