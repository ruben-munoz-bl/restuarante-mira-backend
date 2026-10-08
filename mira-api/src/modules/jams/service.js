/**
 * Reserva en grupo tipo "JAM": el anfitrión propone restaurantes y franjas,
 * comparte un código, el grupo vota en directo y al cerrar la votación MIRA
 * reserva sola la combinación ganadora (si no hay mesa, prueba la siguiente).
 *
 * Coste en Firestore: un documento por sala (`jams/{codigo}`). Las salas se
 * sirven desde memoria: mirar la sala o seguirla en directo (SSE) no lee la
 * base de datos; solo se escribe al crear, unirse, votar y cerrar.
 */
const { EventEmitter } = require("events");
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { logger } = require("../../middlewares/errorHandler");
const { SLOTS } = require("../../config/constants");
const { enviarMensaje } = require("../mensajes/notificar");
const logica = require("./logica");

const salas = new Map(); // codigo → jam
const colas = new Map(); // codigo → promesa (serializa escrituras de una misma sala)
const eventos = new EventEmitter();
eventos.setMaxListeners(0);

const aMs = (v) => (v?.toMillis ? v.toMillis() : v?.toDate ? v.toDate().getTime() : new Date(v).getTime());

function error(mensaje, code, status = 400) {
  const e = new Error(mensaje);
  e.code = code;
  e.status = status;
  return e;
}

/** Ejecuta `fn` en exclusiva para una sala: dos votos a la vez no se pisan. */
function enExclusiva(codigo, fn) {
  const previa = colas.get(codigo) || Promise.resolve();
  const actual = previa.catch(() => {}).then(fn);
  // La cola guarda una versión que nunca rechaza: el error ya lo recibe quien llamó.
  // Sin el catch, cada fallo dejaba un rechazo sin capturar, y eso tumba el proceso de Node.
  const enCola = actual.catch(() => {}).finally(() => { if (colas.get(codigo) === enCola) colas.delete(codigo); });
  colas.set(codigo, enCola);
  return actual;
}

async function guardar(jam) {
  jam.actualizado = new Date().toISOString();
  salas.set(jam.codigo, jam);
  await db.collection("jams").doc(jam.codigo).set(JSON.parse(JSON.stringify(jam)));
  eventos.emit(jam.codigo, jam);
  return jam;
}

async function cargar(codigo) {
  const c = String(codigo || "").toUpperCase();
  if (salas.has(c)) return salas.get(c);
  const snap = await db.collection("jams").doc(c).get();
  if (!snap.exists) throw error("Esa sala no existe", "NOT_FOUND", 404);
  const jam = snap.data();
  salas.set(c, jam);
  return jam;
}

const vencida = (jam) => jam.estado === "abierta" && aMs(jam.cierraEn) <= Date.now();

/** Devuelve la sala; si ya pasó la hora de cierre, la cierra antes (y reserva). */
async function obtener(codigo) {
  const jam = await cargar(codigo);
  return vencida(jam) ? cerrar(jam.codigo, null) : jam;
}

/** Igual que obtener, pero para usar DENTRO de enExclusiva (cerrar ahí pediría el mismo turno y se bloquearía). */
async function obtenerDentro(codigo) {
  const jam = await cargar(codigo);
  return vencida(jam) ? cerrarDentro(jam, null) : jam;
}

async function crear(usuario, propuesta, { obtenerRestaurante }) {
  const errores = logica.validarPropuesta(propuesta, { slots: SLOTS });
  if (errores.length) throw error(errores.join(". "), "VALIDATION_ERROR");
  const restaurantes = [];
  for (const { id } of propuesta.restaurantes) {
    const r = await obtenerRestaurante(id); // caché del catálogo: 0 lecturas
    restaurantes.push({ id: String(id), nombre: r.nombre || "", ciudad: r.ciudad || "", precio: r.precio || "", cocina: (r.categorias || [])[0] || "", imagen: r.imagen_fuente === "google_places" ? null : r.imagen_url || null });
  }
  let codigo = logica.generarCodigo();
  for (let i = 0; i < 3 && salas.has(codigo); i++) codigo = logica.generarCodigo();
  const ahora = new Date();
  const jam = {
    codigo,
    titulo: String(propuesta.titulo || "").trim().slice(0, 80) || "Cena en grupo",
    anfitrionUid: usuario.uid,
    anfitrionNombre: usuario.nombre || "Anfitrión",
    anfitrionEmail: usuario.email || "",
    estado: "abierta",
    restaurantes,
    franjas: propuesta.franjas.map((f) => ({ fecha: f.fecha, hora: f.hora })),
    participantes: {
      [usuario.uid]: { nombre: usuario.nombre || "Anfitrión", restaurantes: [], franjas: [], unidoEn: ahora.toISOString() },
    },
    creado: ahora.toISOString(),
    cierraEn: new Date(ahora.getTime() + Number(propuesta.cierraEnMin) * 60000).toISOString(),
    resultado: null,
  };
  await guardar(jam);
  logger.info({ codigo, uid: usuario.uid }, "JAM creada");
  return jam;
}

function unirse(codigo, usuario) {
  return enExclusiva(String(codigo).toUpperCase(), async () => {
    const jam = await obtenerDentro(codigo);
    if (jam.participantes[usuario.uid]) return jam;
    if (jam.estado !== "abierta") throw error("La votación ya está cerrada", "CERRADA", 409);
    if (Object.keys(jam.participantes).length >= logica.MAX_PARTICIPANTES) throw error("La sala está llena", "LLENA", 409);
    jam.participantes[usuario.uid] = { nombre: (usuario.nombre || "Invitado").slice(0, 40), restaurantes: [], franjas: [], unidoEn: new Date().toISOString() };
    return guardar(jam);
  });
}

function votar(codigo, uid, { restaurantes = [], franjas = [] }) {
  return enExclusiva(String(codigo).toUpperCase(), async () => {
    const jam = await obtenerDentro(codigo);
    if (jam.estado !== "abierta") throw error("La votación ya está cerrada", "CERRADA", 409);
    const p = jam.participantes[uid];
    if (!p) throw error("Únete a la sala para votar", "NO_PARTICIPANTE", 403);
    const idsValidos = new Set(jam.restaurantes.map((r) => r.id));
    p.restaurantes = [...new Set(restaurantes.map(String))].filter((id) => idsValidos.has(id));
    p.franjas = [...new Set(franjas.map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < jam.franjas.length);
    p.votadoEn = new Date().toISOString();
    return guardar(jam);
  });
}

function salir(codigo, uid) {
  return enExclusiva(String(codigo).toUpperCase(), async () => {
    const jam = await obtenerDentro(codigo);
    if (uid === jam.anfitrionUid) throw error("El anfitrión no puede salir: cancela la sala", "ANFITRION", 409);
    if (!jam.participantes[uid] || jam.estado !== "abierta") return jam;
    delete jam.participantes[uid];
    return guardar(jam);
  });
}

function cancelar(codigo, uid) {
  return enExclusiva(String(codigo).toUpperCase(), async () => {
    const jam = await obtenerDentro(codigo);
    if (uid !== jam.anfitrionUid) throw error("Solo el anfitrión puede cancelar", "FORBIDDEN", 403);
    if (jam.estado !== "abierta") return jam;
    jam.estado = "cancelada";
    await guardar(jam);
    await avisar(jam, uid, { titulo: `«${jam.titulo}» se ha cancelado`, cuerpo: `${jam.anfitrionNombre} ha cancelado la votación.` });
    return jam;
  });
}

async function avisar(jam, salvoUid, { titulo, cuerpo }) {
  await Promise.all(Object.keys(jam.participantes).filter((u) => u !== salvoUid).map((u) => enviarMensaje(u, {
    tipo: "jam", titulo, cuerpo, enlace: `#/jam/${jam.codigo}`, enlaceTexto: "Ver la sala", extra: { jam: jam.codigo },
  })));
}

/**
 * Cierra la votación y reserva la combinación ganadora a nombre del anfitrión.
 * `porUid` = quien la cierra a mano (solo el anfitrión); null = cierre automático.
 * Depende de reservations/service, que se carga aquí para no crear un ciclo.
 */
function cerrar(codigo, porUid) {
  return enExclusiva(String(codigo).toUpperCase(), async () => cerrarDentro(await cargar(codigo), porUid));
}

async function cerrarDentro(jam, porUid) {
    if (porUid && porUid !== jam.anfitrionUid) throw error("Solo el anfitrión puede cerrar la votación", "FORBIDDEN", 403);
    if (jam.estado !== "abierta") return jam;
    const { crearReserva } = require("../reservations/service");
    const intentos = [];
    for (const c of logica.combinaciones(jam)) {
      try {
        const r = await crearReserva({
          uid: jam.anfitrionUid,
          restaurantId: c.restauranteId,
          fecha: c.fecha,
          hora: c.hora,
          comensales: c.comensales,
          comentarios: `Reserva en grupo MIRA «${jam.titulo}» (${c.comensales} personas).`,
          usuario: { email: jam.anfitrionEmail, displayName: jam.anfitrionNombre },
        });
        jam.estado = "reservada";
        jam.resultado = { ...c, reservaId: r.id, codigoReserva: r.codigo, intentos: intentos.length + 1, cerradaPor: porUid ? "anfitrion" : "automatico", cerradaEn: new Date().toISOString() };
        break;
      } catch (err) {
        intentos.push({ restauranteId: c.restauranteId, fecha: c.fecha, hora: c.hora, motivo: err.message });
      }
    }
    if (jam.estado !== "reservada") {
      jam.estado = "sin_mesa";
      jam.resultado = { intentos, cerradaPor: porUid ? "anfitrion" : "automatico", cerradaEn: new Date().toISOString() };
    }
    await guardar(jam);
    const r = jam.resultado;
    await avisar(jam, null, jam.estado === "reservada"
      ? { titulo: `🎉 Mesa reservada: ${r.nombre}`, cuerpo: `El grupo «${jam.titulo}» ha elegido ${r.nombre} el ${r.fecha} a las ${r.hora} para ${r.comensales} personas. Código de reserva: ${r.codigoReserva}.` }
      : { titulo: `«${jam.titulo}»: no quedaba mesa`, cuerpo: "Ninguna de las opciones votadas tenía mesa libre. El anfitrión puede crear otra votación con nuevas fechas." });
    logger.info({ codigo: jam.codigo, estado: jam.estado }, "JAM cerrada");
    return jam;
}

/** Salas del usuario (como anfitrión o participante). Consulta pequeña: solo sus salas. */
async function mias(uid) {
  const snap = await db.collection("jams").where("anfitrionUid", "==", uid).get();
  const propias = snap.docs.map((d) => d.data());
  const enMemoria = [...salas.values()].filter((j) => j.participantes?.[uid] && j.anfitrionUid !== uid);
  const vistas = new Map([...propias, ...enMemoria].map((j) => [j.codigo, j]));
  return [...vistas.values()].sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, 20);
}

/** Cierra las salas cuyo plazo ha vencido (cron). Lee solo las abiertas. */
async function cerrarVencidas(ahora = Date.now()) {
  const snap = await db.collection("jams").where("estado", "==", "abierta").get();
  let n = 0;
  for (const d of snap.docs) {
    const jam = d.data();
    if (aMs(jam.cierraEn) > ahora) continue;
    salas.set(jam.codigo, salas.get(jam.codigo) || jam);
    await cerrar(jam.codigo, null);
    n++;
  }
  return n;
}

function suscribir(codigo, fn) {
  const c = String(codigo).toUpperCase();
  eventos.on(c, fn);
  return () => eventos.off(c, fn);
}

function _reset() {
  salas.clear();
  colas.clear();
  eventos.removeAllListeners();
}

module.exports = { crear, obtener, unirse, votar, salir, cancelar, cerrar, mias, cerrarVencidas, suscribir, _reset };
