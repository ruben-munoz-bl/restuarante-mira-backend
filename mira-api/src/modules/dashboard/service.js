const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { env } = require("../../config/env");

const ESTADOS_PENDIENTES = new Set(["pendiente", "confirmada", "activa", "en_mesa", "en mesa"]);
const isPendiente = (s) => ESTADOS_PENDIENTES.has(String(s || "").toLowerCase());
const isCompletada = (s) => ["completada", "pagado", "pagada"].includes(String(s || "").toLowerCase());
const isCancelada = (s) => String(s || "").toLowerCase() === "cancelada";
const isNoShow = (s) => ["no_show", "no-show", "no show"].includes(String(s || "").toLowerCase());

async function fetchReservasForRestaurant(restaurantId) {
  const tryQuery = async (field) => {
    try {
      const q = db.collection("reservas").where(field, "==", restaurantId).orderBy("fecha", "desc").limit(500);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      try {
        const q2 = db.collection("reservas").where(field, "==", restaurantId).limit(500);
        const snap2 = await q2.get();
        const arr = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
        arr.sort((a, b) => `${b.fecha || ""} ${b.hora || ""}`.localeCompare(`${a.fecha || ""} ${a.hora || ""}`));
        return arr;
      } catch {
        return [];
      }
    }
  };
  const [a, b] = await Promise.all([tryQuery("restaurantId"), tryQuery("restauranteId")]);
  const map = new Map();
  for (const r of a) map.set(r.id, r);
  for (const r of b) if (!map.has(r.id)) map.set(r.id, r);
  const merged = Array.from(map.values());
  merged.sort((x, y) => `${y.fecha || ""} ${y.hora || ""}`.localeCompare(`${x.fecha || ""} ${x.hora || ""}`));
  return merged;
}

function buildRestaurantAggregates(reservas, tickets, finanzas) {
  const hoy = new Date().toISOString().split("T")[0];
  const totalReservas = reservas.length;
  const reservasCompletadas = reservas.filter((r) => isCompletada(r.estado)).length;
  const reservasCanceladas = reservas.filter((r) => isCancelada(r.estado)).length;
  const reservasNoShow = reservas.filter((r) => isNoShow(r.estado)).length;
  const reservasPendientes = reservas.filter((r) => isPendiente(r.estado)).length;
  const reservasHoyCount = reservas.filter((r) => r.fecha === hoy && !isCancelada(r.estado)).length;

  const totalFacturacion = finanzas
    ? Number(finanzas.ingresosBrutos) || 0
    : tickets.reduce((s, t) => s + (t.totalPagado || 0), 0);
  const totalComisiones = finanzas
    ? Number(finanzas.comisiones) || 0
    : tickets.reduce((s, t) => s + (t.importeComision || 0), 0);
  const totalTicketsFin = finanzas ? Number(finanzas.totalTickets) || tickets.length : tickets.length;
  const comensalesFin = finanzas ? Number(finanzas.comensalesAtendidos) || 0 : 0;

  const proximasReservas = reservas
    .filter((r) => r.fecha >= hoy && isPendiente(r.estado))
    .sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`))
    .slice(0, 20);

  const reservasHoyList = reservas
    .filter((r) => r.fecha === hoy && !isCancelada(r.estado))
    .sort((a, b) => String(a.hora || "").localeCompare(String(b.hora || "")));

  const reservasParaTicket = reservas
    .filter((r) => !isCancelada(r.estado) && !r.ticketId)
    .sort((a, b) => `${b.fecha || ""} ${b.hora || ""}`.localeCompare(`${a.fecha || ""} ${a.hora || ""}`))
    .slice(0, 50);

  const reservasNoCanceladas = reservas.filter((r) => !isCancelada(r.estado)).length;

  const ingresosPorMes = {};
  tickets.forEach((t) => {
    const fecha = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
    if (!ingresosPorMes[mes]) ingresosPorMes[mes] = { facturacion: 0, comisiones: 0, tickets: 0 };
    ingresosPorMes[mes].facturacion += t.totalPagado || 0;
    ingresosPorMes[mes].comisiones += t.importeComision || 0;
    ingresosPorMes[mes].tickets += 1;
  });

  return {
    stats: {
      totalReservas,
      reservasCompletadas,
      reservasCanceladas,
      reservasNoShow,
      reservasPendientes,
      reservasHoy: reservasHoyCount,
      totalFacturacion: Math.round(totalFacturacion * 100) / 100,
      totalComisiones: Math.round(totalComisiones * 100) / 100,
      ticketPromedio: totalTicketsFin > 0 ? Math.round((totalFacturacion / totalTicketsFin) * 100) / 100 : 0,
      totalTicketsFin,
      comensalesFin,
      reservasNoCanceladas,
    },
    proximasReservas,
    reservasHoy: reservasHoyList,
    reservasParaTicket,
    ingresosPorMes,
    ticketsRecientes: tickets.slice(0, 20),
  };
}

async function listMyRestaurants(uid, email, currentId) {
  const ids = new Set();
  const meta = new Map();
  const seenIds = new Set();
  if (currentId) ids.add(currentId);

  const [userDoc, restByUid, negSnap, restByEmail] = await Promise.all([
    db.collection("usuarios").doc(uid).get().catch(() => null),
    db.collection("restaurants").where("uid", "==", uid).get().catch(() => null),
    db.collection("negocios").where("uid", "==", uid).get().catch(() => null),
    email ? db.collection("restaurants").where("email", "==", email).get().catch(() => null) : Promise.resolve(null),
  ]);

  const userData = userDoc && userDoc.exists ? userDoc.data() : {};
  if (Array.isArray(userData.restaurantIds)) userData.restaurantIds.forEach((id) => id && ids.add(id));
  if (userData.restaurantId) ids.add(userData.restaurantId);
  if (restByUid) restByUid.docs.forEach((d) => ids.add(d.id));
  if (restByEmail) restByEmail.docs.forEach((d) => ids.add(d.id));

  const aprobadas = [];
  if (negSnap) {
    negSnap.docs.forEach((d) => {
      const n = d.data();
      if (n?.estado !== "aprobada") return;
      aprobadas.push(n);
      meta.set(n.restaurantId || `neg:${d.id}`, { nombre: n.nombre || "", ciudad: n.ciudad || "" });
      if (n.restaurantId) ids.add(n.restaurantId);
    });
  }

  const sinId = aprobadas.filter((n) => !n.restaurantId);
  if (sinId.length) {
    await Promise.all(
      sinId.map(async (n) => {
        try {
          const snap = await db.collection("restaurants").where("nombre", "==", n.nombre).get();
          const match = snap.docs.find((d) => {
            const r = d.data();
            return r.uid === uid || (n.email && r.email === n.email) || (!r.uid && !r.email);
          }) || snap.docs[0];
          if (match) {
            ids.add(match.id);
            meta.set(match.id, { nombre: n.nombre || "", ciudad: n.ciudad || "" });
          }
        } catch { /* skip */ }
      }),
    );
  }

  const idList = [...ids].filter((id) => id && !String(id).startsWith("neg:"));
  const docs = await Promise.all(idList.map((id) => db.collection("restaurants").doc(id).get().catch(() => null)));

  const lista = [];
  const seen = new Set();
  idList.forEach((id, i) => {
    if (seen.has(id)) return;
    const d = docs[i];
    const m = meta.get(id);
    if (d && d.exists) {
      seen.add(id);
      const rd = d.data();
      lista.push({ id, nombre: rd.nombre || m?.nombre || "", ciudad: rd.ciudad || m?.ciudad || "" });
    } else if (m) {
      seen.add(id);
      lista.push({ id, nombre: m.nombre || "Restaurante", ciudad: m.ciudad || "" });
    }
  });

  aprobadas.forEach((n) => {
    const already = lista.some((r) => r.nombre === n.nombre && (!n.restaurantId || r.id === n.restaurantId));
    if (!already && n.restaurantId && !seen.has(n.restaurantId)) {
      lista.push({ id: n.restaurantId, nombre: n.nombre || "Restaurante", ciudad: n.ciudad || "" });
    }
  });

  if (currentId && !lista.some((r) => r.id === currentId)) {
    const d = docs[idList.indexOf(currentId)];
    const m = meta.get(currentId);
    lista.unshift({
      id: currentId,
      nombre: (d && d.exists && d.data().nombre) || m?.nombre || "Restaurante activo",
      ciudad: (d && d.exists && d.data().ciudad) || m?.ciudad || "",
    });
  }

  return lista;
}

function notFoundError() {
  const err = new Error("Restaurante no encontrado");
  err.status = 404;
  err.code = "NOT_FOUND";
  return err;
}

async function resolveRestaurantId(uid, restaurantIdOverride) {
  if (restaurantIdOverride) return restaurantIdOverride;
  const userDoc = await db.collection("usuarios").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  if (userData.restaurantId) return userData.restaurantId;
  const snap = await db.collection("restaurants").where("uid", "==", uid).limit(1).get();
  if (snap.empty) throw notFoundError();
  return snap.docs[0].id;
}

async function getMyRestaurant(uid, restaurantIdOverride) {
  const restaurantId = await resolveRestaurantId(uid, restaurantIdOverride);
  const restDoc = await db.collection("restaurants").doc(restaurantId).get();
  if (!restDoc.exists) throw notFoundError();
  const restaurante = { id: restDoc.id, ...restDoc.data() };

  const [reservas, ticketsSnap, finanzasSnap] = await Promise.all([
    fetchReservasForRestaurant(restaurantId),
    db.collection("tickets").where("restaurantId", "==", restaurantId).orderBy("createdAt", "desc").limit(500).get().catch(async () =>
      db.collection("tickets").where("restaurantId", "==", restaurantId).limit(500).get(),
    ),
    db.collection("finanzas_restaurante").doc(restaurantId).get().catch(() => ({ exists: () => false, data: () => null })),
  ]);
  const tickets = ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const finanzas = finanzasSnap && finanzasSnap.exists ? finanzasSnap.data() : null;

  const agg = buildRestaurantAggregates(reservas, tickets, finanzas);
  return { restaurante, finanzas, ...agg };
}

async function getAdminDashboard() {
  const [usersSnap, reservasSnap, ticketsSnap, promosSnap] = await Promise.all([
    db.collection("usuarios").get(),
    db.collection("reservas").orderBy("createdAt", "desc").limit(2000).get(),
    db.collection("tickets").orderBy("createdAt", "desc").limit(2000).get(),
    db.collection("promociones").get(),
  ]);

  const users = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const reservas = reservasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const tickets = ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const totalUsuarios = usersSnap.size;
  const usuariosActivos = users.filter((u) => u.tipo !== "admin").length;
  const totalReservas = reservas.length;
  const reservasCompletadas = reservas.filter((r) => r.estado === "completada").length;
  const reservasCanceladas = reservas.filter((r) => r.estado === "cancelada").length;
  const reservasNoShow = reservas.filter((r) => r.estado === "no_show").length;
  const totalFacturacion = tickets.reduce((s, t) => s + (t.totalPagado || 0), 0);
  const totalComisiones = tickets.reduce((s, t) => s + (t.importeComision || 0), 0);

  const reservasPorRestaurante = {};
  reservas.forEach((r) => {
    const key = r.restaurantId || "unknown";
    if (!reservasPorRestaurante[key]) {
      reservasPorRestaurante[key] = { nombre: r.nombreRestaurante || key, total: 0, completadas: 0, canceladas: 0, noShow: 0 };
    }
    reservasPorRestaurante[key].total++;
    if (r.estado === "completada") reservasPorRestaurante[key].completadas++;
    if (r.estado === "cancelada") reservasPorRestaurante[key].canceladas++;
    if (r.estado === "no_show") reservasPorRestaurante[key].noShow++;
  });

  const facturacionPorMes = {};
  tickets.forEach((t) => {
    const fecha = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
    if (!facturacionPorMes[mes]) facturacionPorMes[mes] = { facturacion: 0, comisiones: 0, tickets: 0, reservas: 0 };
    facturacionPorMes[mes].facturacion += t.totalPagado || 0;
    facturacionPorMes[mes].comisiones += t.importeComision || 0;
    facturacionPorMes[mes].tickets += 1;
  });
  reservas.forEach((r) => {
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
      promosActivas: promosSnap.docs.filter((d) => d.data().estado === "activa").length,
    },
    reservasPorRestaurante,
    facturacionPorMes,
    ticketsRecientes: tickets.slice(0, 30),
  };
}

const PRECIO_MEDIO_PAX = Number(env.TICKET_PRECIO_EURO) || 18;
const COMISION_PCT = Number(env.COMISION_PCT) || 8;

function fechaDeDoc(d) {
  if (d.createdAt instanceof Date) return d.createdAt;
  if (typeof d.createdAt === "string") {
    const parsed = new Date(d.createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (d.createdAt?.seconds) return new Date(d.createdAt.seconds * 1000);
  const f = d.fecha ? new Date(`${d.fecha}T${d.hora || "12:00"}`) : null;
  return f && !Number.isNaN(f.getTime()) ? f : null;
}

function diaISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nombreRestauranteDe(r) {
  return r.nombreRestaurante || r.restauranteNombre || r.restaurantName || "—";
}

function idRestauranteDe(r) {
  return r.restaurantId || r.restauranteId || "unknown";
}

async function getOpsOverview() {
  const avisos = [];
  const r = await Promise.allSettled([
    db.collection("reservas").orderBy("createdAt", "desc").limit(500).get(),
    db.collection("tickets").orderBy("createdAt", "desc").limit(200).get(),
    db.collection("restaurants").count().get(),
    db.collection("usuarios").count().get(),
    require("../contactos/service").listarPendientes().catch(() => []),
    require("../negocios/service").listarNegociosPendientes().catch(() => []),
  ]);
  const nombres = ["reservas", "tickets", "restaurants", "usuarios", "contactos", "negocios"];
  r.forEach((x, i) => {
    if (x.status === "rejected") avisos.push(nombres[i]);
  });

  const reservas = r[0].status === "fulfilled" ? r[0].value.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  const tickets = r[1].status === "fulfilled" ? r[1].value.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  const nRest = r[2].status === "fulfilled" ? r[2].value.data().count : 0;
  const nUsu = r[3].status === "fulfilled" ? r[3].value.data().count : 0;
  const pendientes = r[4].status === "fulfilled" ? r[4].value : [];
  const negocios = r[5].status === "fulfilled" ? r[5].value : [];

  const hoy = new Date();
  const hoyISO = diaISO(hoy);
  const hace7 = new Date(hoy.getTime() - 7 * 86400000);
  const hace7ISO = diaISO(hace7);

  // Ingresos y comisiones REALES (solo tickets subidos / liquidados).
  const facturacionReal = tickets.reduce((s, t) => s + (Number(t.totalPagado) || 0), 0);
  const comisionReal = tickets.reduce((s, t) => s + (Number(t.importeComision) || 0), 0);
  const ticketPromedio = tickets.length
    ? Math.round((facturacionReal / tickets.length) * 100) / 100
    : 0;

  const ticketsPorDia = {};
  tickets.forEach((t) => {
    const f = fechaDeDoc(t);
    if (!f) return;
    const iso = diaISO(f);
    if (!ticketsPorDia[iso]) ticketsPorDia[iso] = { facturacion: 0, comisiones: 0, tickets: 0 };
    ticketsPorDia[iso].facturacion += Number(t.totalPagado) || 0;
    ticketsPorDia[iso].comisiones += Number(t.importeComision) || 0;
    ticketsPorDia[iso].tickets += 1;
  });

  const porEstado = { confirmada: 0, pendiente: 0, completada: 0, cancelada: 0, no_show: 0 };
  reservas.forEach((res) => {
    const e = res.estado || "pendiente";
    if (porEstado[e] == null) porEstado[e] = 0;
    porEstado[e] += 1;
  });
  const activas = reservas.filter((res) => res.estado !== "cancelada");
  const asistidas = reservas.filter((res) => res.estado === "completada").length;
  const asistenciaPct = activas.length ? Math.round((asistidas / activas.length) * 1000) / 10 : 0;

  const paxConTicket = reservas
    .filter((res) => res.ticketId && res.estado !== "cancelada")
    .reduce((s, res) => s + (Number(res.comensales) || 0), 0);
  const mediaComensal = paxConTicket
    ? Math.round((facturacionReal / paxConTicket) * 100) / 100
    : PRECIO_MEDIO_PAX;

  const serie = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(hoy.getTime() - i * 86400000);
    const iso = diaISO(d);
    const delDia = reservas.filter((res) => {
      const f = fechaDeDoc(res);
      return f && diaISO(f) === iso && res.estado !== "cancelada";
    });
    const tDia = ticketsPorDia[iso] || { facturacion: 0, comisiones: 0, tickets: 0 };
    serie.push({
      fecha: iso,
      etiqueta: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      reservas: delDia.length,
      pax: delDia.reduce((s, res) => s + (Number(res.comensales) || 0), 0),
      // Valores REALES de tickets del día (0 si aún no hay tickets).
      facturacion: Math.round(tDia.facturacion * 100) / 100,
      comisiones: Math.round(tDia.comisiones * 100) / 100,
      tickets: tDia.tickets,
    });
  }

  const ultimos7 = reservas.filter((res) => {
    const f = fechaDeDoc(res);
    return f && diaISO(f) >= hace7ISO && res.estado !== "cancelada";
  });
  const horaDe = (res) => Number(String(res.hora || "0").split(":")[0]);
  const comida = ultimos7.filter((res) => horaDe(res) >= 13 && horaDe(res) < 17);
  const cena = ultimos7.filter((res) => horaDe(res) >= 20 && horaDe(res) < 24);
  const paxComida = comida.reduce((s, res) => s + (Number(res.comensales) || 0), 0);
  const paxCena = cena.reduce((s, res) => s + (Number(res.comensales) || 0), 0);

  // Top de hoy: comisión REAL de tickets emitidos hoy (no estimación).
  const ticketsHoy = tickets.filter((t) => {
    const f = fechaDeDoc(t);
    return f && diaISO(f) === hoyISO;
  });
  const porRest = {};
  reservas.forEach((res) => {
    if (res.estado === "cancelada") return;
    const key = idRestauranteDe(res);
    if (!porRest[key]) {
      porRest[key] = { id: key, nombre: nombreRestauranteDe(res), paxHoy: 0, reservasHoy: 0, comisionHoy: 0, ticketsHoy: 0 };
    }
    const f = fechaDeDoc(res);
    if (f && diaISO(f) === hoyISO) {
      porRest[key].paxHoy += Number(res.comensales) || 0;
      porRest[key].reservasHoy += 1;
    }
  });
  ticketsHoy.forEach((t) => {
    const key = t.restaurantId || t.restauranteId || "unknown";
    if (!porRest[key]) {
      porRest[key] = {
        id: key,
        nombre: t.restauranteNombre || t.nombreRestaurante || key,
        paxHoy: 0,
        reservasHoy: 0,
        comisionHoy: 0,
        ticketsHoy: 0,
      };
    }
    porRest[key].comisionHoy += Number(t.importeComision) || 0;
    porRest[key].ticketsHoy += 1;
  });
  const top = Object.values(porRest)
    .filter((x) => x.reservasHoy > 0 || x.ticketsHoy > 0)
    .map((x) => ({ ...x, comisionHoy: Math.round(x.comisionHoy * 100) / 100 }))
    .sort((a, b) => b.paxHoy - a.paxHoy || b.comisionHoy - a.comisionHoy)
    .slice(0, 5);

  const criticas = pendientes.filter((p) =>
    /no-show|cargo|disputa|cobro/i.test(`${p.motivo || ""} ${p.mensaje || ""}`),
  ).length;
  const incidenciasPreview = [
    ...pendientes.slice(0, 3).map((p) => ({ kind: "contacto", ...p })),
    ...negocios.slice(0, Math.max(0, 3 - Math.min(3, pendientes.length))).map((n) => ({ kind: "negocio", ...n })),
  ].slice(0, 3);

  // Feed: comisión REAL si la reserva ya tiene ticket; si no, 0 (no inventar).
  const feed = reservas.slice(0, 8).map((res) => ({
    ...res,
    nombreRest: nombreRestauranteDe(res),
    comision: Math.round((Number(res.importeComision) || 0) * 100) / 100,
    comisionReal: Boolean(res.ticketId),
    antiguedad: antiguedadCorta(res.createdAt),
  }));

  // Altas de restaurantes en los últimos 7 días (createdAt real).
  let altas7d = 0;
  try {
    const rests = await db.collection("restaurants").orderBy("createdAt", "desc").limit(100).get();
    const limite = hoy.getTime() - 7 * 86400000;
    rests.docs.forEach((doc) => {
      const c = doc.data().createdAt;
      if (!c) return;
      const fecha = c.toDate ? c.toDate() : new Date(c);
      if (!Number.isNaN(fecha.getTime()) && fecha.getTime() >= limite) altas7d += 1;
    });
  } catch { /* sin índice / sin datos */ }

  return {
    avisos,
    kpis: {
      reservasTotal: reservas.length,
      asistenciaPct,
      restaurantesActivos: nRest,
      incidenciasPendientes: pendientes.length + negocios.length,
      criticas,
      usuariosTotal: nUsu,
      // REALES (solo tickets); 0 si aún no hay tickets subidos.
      comisionTotal: Math.round(comisionReal * 100) / 100,
      facturacionTotal: Math.round(facturacionReal * 100) / 100,
      ticketPromedio,
      mediaComensal,
      ticketsTotal: tickets.length,
      comisionPct: COMISION_PCT,
      precioMedioPax: PRECIO_MEDIO_PAX,
      altas7d,
      negociosPendientes: negocios.length,
    },
    serie,
    porEstado,
    ocupacion: {
      comida: { reservas: comida.length, pax: paxComida },
      cena: { reservas: cena.length, pax: paxCena },
    },
    incidenciasPreview,
    pendientesTotal: pendientes.length,
    negociosTotal: negocios.length,
    top,
    feed,
  };
}

function antiguedadCorta(ts) {
  if (!ts) return "—";
  const d = ts instanceof Date ? ts : ts?.toDate ? ts.toDate() : typeof ts === "string" ? new Date(ts) : ts?.seconds ? new Date(ts.seconds * 1000) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

async function getReservasGlobales({ q = "", estado = "", limite = 100 } = {}) {
  const snap = await db.collection("reservas").orderBy("createdAt", "desc").limit(500).get();
  let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nq = q.trim().toLowerCase();
  if (nq) {
    list = list.filter((res) =>
      [res.codigo, res.usuarioEmail, res.email, res.usuarioNombre, nombreRestauranteDe(res), res.fecha]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(nq),
    );
  }
  if (estado) list = list.filter((res) => (res.estado || "pendiente") === estado);
  return list.slice(0, limite);
}

async function updateRestaurant(restaurantId, data) {
  const allowed = ["nombre", "direccion", "telefono", "email", "horarios", "activo", "ciudad", "zona", "precio", "cocina", "descripcion", "comisionPct", "maxReservasPorHora"];
  const update = {};
  allowed.forEach((k) => {
    if (data[k] !== undefined) update[k] = data[k];
  });
  if (Object.keys(update).length === 0) return { updated: false };
  update.updatedAt = new Date();
  const ref = db.collection("restaurants").doc(restaurantId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("Restaurante no encontrado");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  await ref.update(update);
  logger.info({ restaurantId, fields: Object.keys(update) }, "Restaurant updated");
  return { updated: true };
}

async function eliminarRestaurante(restaurantId) {
  const ref = db.collection("restaurants").doc(restaurantId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("Restaurante no encontrado");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  await ref.delete();
  logger.info({ restaurantId }, "Restaurant deleted");
  return { deleted: true, id: restaurantId };
}

async function enviarMensajeDueno(restaurantId, { asunto, mensaje, adminUid }) {
  const snap = await db.collection("restaurants").doc(restaurantId).get();
  if (!snap.exists) {
    const err = new Error("Restaurante no encontrado");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const r = snap.data();
  const uidDueno = r.ownerUid || r.uid || null;
  const emailDueno = r.email || null;
  if (!uidDueno && !emailDueno) {
    const err = new Error("Este restaurante no tiene dueño asociado (sin uid ni email)");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const now = new Date();
  const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(now);
  const hora = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  const doc = {
    titulo: asunto || `Mensaje del equipo MIRA — ${r.nombre || restaurantId}`,
    cuerpo: mensaje,
    fecha,
    hora,
    leido: false,
    tipo: "admin",
    de: adminUid || "admin",
    restaurantId,
    restauranteNombre: r.nombre || "",
    creado: now,
  };

  let ref;
  if (uidDueno) {
    ref = await db.collection("mensajes").add({ ...doc, uid: uidDueno });
  } else {
    // Sin uid: queda como mensaje "pendiente de entrega" indexado por email (buzón del dueño si luego se asocia).
    ref = await db.collection("mensajes").add({ ...doc, uid: null, emailDueno });
  }

  logger.info({ restaurantId, uidDueno, mensajeId: ref.id }, "Admin message to owner");
  return {
    ok: true,
    id: ref.id,
    uidDueno,
    aviso: uidDueno
      ? "Mensaje enviado al buzón del dueño."
      : "Guardado; el dueño no tiene uid asociado (solo email).",
  };
}

async function updateReservationStatus(reservaId, status, { precioBase } = {}) {
  const { actualizarEstado } = require("../reservations/service");
  return actualizarEstado(reservaId, status, { precioBase });
}

async function addPointsManually(uid, cantidad, motivo) {
  const { addPuntos } = require("../points/service");
  const n = Number(cantidad);
  const tipo = n >= 0 ? "ajuste_admin" : "ajuste_admin_negativo";
  return addPuntos(uid, n, tipo, motivo || `Ajuste admin (${n > 0 ? "+" : ""}${n})`);
}

/** Pone ultimoLoginDate en ayer (Madrid) para que hoy siga reclamable. */
function ayerMadrid() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(Date.now() - 86400000));
}

async function setRachaAdmin(uid, dias, { ultimoLoginDate } = {}) {
  const userRef = db.collection("usuarios").doc(uid);
  const clamp = Math.max(0, Math.min(7, Math.floor(dias)));
  const ultimo = ultimoLoginDate !== undefined ? ultimoLoginDate : ayerMadrid();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error("Usuario no encontrado");
    tx.update(userRef, {
      rachaLoginDias: clamp,
      ultimoLoginDate: ultimo,
      graceUsados: 0,
      updatedAt: new Date(),
    });
  });
  const { getBalance } = require("../points/service");
  return getBalance(uid);
}

/** Suma (o resta con delta negativo) días a la racha actual, clamp 0–7. */
async function ajustarRachaDias(uid, delta) {
  const userRef = db.collection("usuarios").doc(uid);
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
  const snap = await userRef.get();
  if (!snap.exists) throw new Error("Usuario no encontrado");
  const d = snap.data();
  const actual = Math.min(d.rachaLoginDias || 0, 7);
  const nuevo = Math.max(0, Math.min(7, actual + delta));
  // Si ya reclamó hoy y restamos, deja ayer reclamable; si solo sumamos, respeta el estado actual.
  let ultimo = d.ultimoLoginDate || null;
  if (delta < 0 && ultimo === hoy) ultimo = ayerMadrid();
  await userRef.update({
    rachaLoginDias: nuevo,
    ultimoLoginDate: ultimo,
    graceUsados: d.graceUsados || 0,
    updatedAt: new Date(),
  });
  const { getBalance } = require("../points/service");
  return getBalance(uid);
}

/** Deshace el login de hoy: ultimoLogin=ayer, racha−1 si estaba reclamado hoy. */
async function unclaimLoginHoy(uid) {
  const userRef = db.collection("usuarios").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error("Usuario no encontrado");
  const d = snap.data();
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
  const reclamadoHoy = (d.ultimoLoginDate || null) === hoy;
  const diasBase = Math.min(d.rachaLoginDias || 0, 7);
  const dias = reclamadoHoy ? Math.max(0, diasBase - 1) : diasBase;
  await userRef.update({
    rachaLoginDias: dias,
    ultimoLoginDate: ayerMadrid(),
    graceUsados: d.graceUsados || 0,
    updatedAt: new Date(),
  });
  const { getBalance } = require("../points/service");
  return {
    balance: await getBalance(uid),
    estabaReclamadoHoy: reclamadoHoy,
  };
}

module.exports = {
  listMyRestaurants,
  getMyRestaurant,
  getAdminDashboard,
  getOpsOverview,
  getReservasGlobales,
  updateRestaurant,
  eliminarRestaurante,
  enviarMensajeDueno,
  updateReservationStatus,
  addPointsManually,
  setRachaAdmin,
  ajustarRachaDias,
  unclaimLoginHoy,
};
