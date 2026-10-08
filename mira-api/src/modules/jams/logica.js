/**
 * Lógica pura de la reserva en grupo (JAM): validar propuestas, recontar votos
 * y decidir en qué orden se intentan las combinaciones restaurante + franja.
 */
const crypto = require("crypto");

const MAX_RESTAURANTES = 4;
const MAX_FRANJAS = 4;
const MAX_PARTICIPANTES = 20;
// Sin 0/O/1/I/L para que el código se pueda dictar sin errores.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generarCodigo(rand = crypto.randomBytes) {
  const b = rand(6);
  return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join("");
}

/** Id público de participante: no expone el uid de Firebase en la sala compartida. */
function idPublico(codigo, uid) {
  return crypto.createHash("sha256").update(`${codigo}:${uid}`).digest("hex").slice(0, 10);
}

/**
 * Recuento: votos por restaurante (cada participante puede votar varios) y
 * cuántos pueden ir a cada franja. Empates: el orden en que se propusieron.
 */
function recontar(jam) {
  const ps = Object.values(jam.participantes || {});
  const restaurantes = jam.restaurantes.map((r, i) => ({
    ...r,
    orden: i,
    votos: ps.filter((p) => (p.restaurantes || []).includes(r.id)).length,
  }));
  const franjas = jam.franjas.map((f, i) => ({
    ...f,
    indice: i,
    pueden: ps.filter((p) => (p.franjas || []).includes(i)).length,
  }));
  return {
    restaurantes: [...restaurantes].sort((a, b) => b.votos - a.votos || a.orden - b.orden),
    franjas: [...franjas].sort((a, b) => b.pueden - a.pueden || `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`)),
    participantes: ps.length,
    hanVotado: ps.filter((p) => (p.restaurantes || []).length || (p.franjas || []).length).length,
  };
}

/**
 * Orden de intentos para reservar: primero el restaurante más votado con la franja
 * a la que más pueden ir; si no hay mesa, la siguiente franja; luego el siguiente
 * restaurante. Comensales = los que pueden ir a esa franja (mín. 1, máx. 10).
 * Las franjas a las que no puede ir nadie no se intentan si hay alguna con gente.
 */
function combinaciones(jam) {
  const { restaurantes, franjas } = recontar(jam);
  const conGente = franjas.filter((f) => f.pueden > 0);
  const usables = conGente.length ? conGente : franjas;
  const out = [];
  for (const r of restaurantes) {
    for (const f of usables) {
      out.push({ restauranteId: r.id, nombre: r.nombre, fecha: f.fecha, hora: f.hora, comensales: Math.min(10, Math.max(1, f.pueden)), votos: r.votos, pueden: f.pueden });
    }
  }
  return out;
}

function validarPropuesta({ titulo, restaurantes, franjas, cierraEnMin }, { slots, ahora = new Date() }) {
  const errores = [];
  if (!Array.isArray(restaurantes) || restaurantes.length < 1 || restaurantes.length > MAX_RESTAURANTES) errores.push(`Elige entre 1 y ${MAX_RESTAURANTES} restaurantes`);
  if (new Set((restaurantes || []).map((r) => r.id)).size !== (restaurantes || []).length) errores.push("Hay restaurantes repetidos");
  if (!Array.isArray(franjas) || franjas.length < 1 || franjas.length > MAX_FRANJAS) errores.push(`Propón entre 1 y ${MAX_FRANJAS} franjas`);
  for (const f of franjas || []) {
    if (!slots.includes(f.hora)) errores.push(`Hora no válida: ${f.hora}`);
    const t = new Date(`${f.fecha}T${f.hora}:00+02:00`).getTime();
    if (!Number.isFinite(t) || t <= ahora.getTime()) errores.push(`La franja ${f.fecha} ${f.hora} ya ha pasado`);
  }
  if (new Set((franjas || []).map((f) => `${f.fecha} ${f.hora}`)).size !== (franjas || []).length) errores.push("Hay franjas repetidas");
  const min = Number(cierraEnMin);
  if (!Number.isFinite(min) || min < 5 || min > 7 * 24 * 60) errores.push("La votación debe durar entre 5 minutos y 7 días");
  const primeraFranja = Math.min(...(franjas || []).map((f) => new Date(`${f.fecha}T${f.hora}:00+02:00`).getTime()));
  if (Number.isFinite(primeraFranja) && ahora.getTime() + min * 60000 > primeraFranja) errores.push("La votación tiene que cerrar antes de la primera franja");
  if (titulo != null && String(titulo).length > 80) errores.push("Título demasiado largo");
  return errores;
}

/** Vista pública de la sala: sin uids ni emails, con el recuento ya hecho. */
function vistaPublica(jam, uidSolicitante = null) {
  const recuento = recontar(jam);
  return {
    codigo: jam.codigo,
    titulo: jam.titulo,
    anfitrion: jam.anfitrionNombre,
    estado: jam.estado,
    cierraEn: jam.cierraEn,
    creado: jam.creado,
    restaurantes: jam.restaurantes,
    franjas: jam.franjas,
    participantes: Object.entries(jam.participantes || {}).map(([uid, p]) => ({
      id: idPublico(jam.codigo, uid),
      nombre: p.nombre,
      esAnfitrion: uid === jam.anfitrionUid,
      restaurantes: p.restaurantes || [],
      franjas: p.franjas || [],
      unidoEn: p.unidoEn,
    })),
    recuento: {
      participantes: recuento.participantes,
      hanVotado: recuento.hanVotado,
      restaurantes: recuento.restaurantes.map(({ id, votos }) => ({ id, votos })),
      franjas: recuento.franjas.map(({ indice, pueden }) => ({ indice, pueden })),
    },
    resultado: jam.resultado || null,
    miId: uidSolicitante ? idPublico(jam.codigo, uidSolicitante) : null,
    soyAnfitrion: Boolean(uidSolicitante && uidSolicitante === jam.anfitrionUid),
    estoyDentro: Boolean(uidSolicitante && jam.participantes?.[uidSolicitante]),
  };
}

module.exports = {
  MAX_RESTAURANTES, MAX_FRANJAS, MAX_PARTICIPANTES, generarCodigo, idPublico, recontar, combinaciones, validarPropuesta, vistaPublica,
};
