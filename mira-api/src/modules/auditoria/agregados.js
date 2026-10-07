/**
 * Agregados de auditoría a partir de una lista de eventos (funciones puras).
 * Nunca se inventan valores: si no hay base, el campo va a null y la UI pinta "—".
 */
const { CATEGORIA_DE, TIPOS_CONFIG } = require("./catalogo");
const { claveCubo, cubosDelRango } = require("./esquema");

const DIMENSIONES = ["tipo", "origen", "fuente", "actorTipo", "dispositivo.tipo", "dispositivo.os",
  "dispositivo.navegador", "pagina", "pais", "entidadTipo", "categoria", "resultado"];

function valorDe(e, dimension) {
  if (dimension === "categoria") return CATEGORIA_DE[e.tipo] || null;
  if (dimension === "pais") return e.dispositivo?.pais || null;
  if (dimension.startsWith("dispositivo.")) return e.dispositivo?.[dimension.slice(12)] || null;
  return e[dimension] ?? null;
}

function enRango(lista, desde, hasta) {
  return lista.filter((e) => e.ts >= desde && e.ts < hasta);
}

/** Filtros comunes: fuente, tipos, origen, resultado, actor, entidad, dispositivo y texto libre. */
function filtrar(lista, f = {}) {
  const tipos = f.tipos ? new Set(String(f.tipos).split(",").filter(Boolean)) : null;
  const q = f.buscar ? String(f.buscar).toLowerCase().trim() : "";
  return lista.filter((e) =>
    (!f.fuente || f.fuente === "todo" || e.fuente === f.fuente)
    && (!tipos || tipos.has(e.tipo))
    && (!f.categoria || CATEGORIA_DE[e.tipo] === f.categoria)
    && (!f.origen || e.origen === f.origen)
    && (!f.resultado || e.resultado === f.resultado)
    && (!f.actorUid || e.actorUid === f.actorUid)
    && (!f.actorTipo || e.actorTipo === f.actorTipo)
    && (!f.entidadId || e.entidadId === f.entidadId)
    && (!f.dispositivo || e.dispositivo?.tipo === f.dispositivo)
    && (!q || [e.tipo, e.actorNombre, e.actorUid, e.entidadNombre, e.entidadId, e.pagina, e.ruta, e.accion, e.mensajeError]
      .filter(Boolean).join(" ").toLowerCase().includes(q)));
}

/** Top N con conteo, % sobre el total y share acumulado. */
function breakdown(lista, dimension, top = 10) {
  const cuenta = new Map();
  for (const e of lista) {
    const v = valorDe(e, dimension) ?? "sin dato";
    cuenta.set(v, (cuenta.get(v) || 0) + 1);
  }
  const total = lista.length;
  const filas = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  let acumulado = 0;
  const items = filas.slice(0, top).map(([valor, n]) => {
    acumulado += n;
    return { valor, n, pct: total ? Math.round((n / total) * 1000) / 10 : null, share: total ? Math.round((acumulado / total) * 1000) / 10 : null };
  });
  const resto = filas.slice(top).reduce((s, [, n]) => s + n, 0);
  return { dimension, total, items, resto };
}

function contarDistintos(lista, campo) {
  return new Set(lista.map((e) => e[campo]).filter(Boolean)).size;
}

function kpis(lista) {
  const errores = lista.filter((e) => e.resultado === "error").length;
  return {
    eventos: lista.length,
    sesiones: contarDistintos(lista, "sesionId"),
    usuariosActivos: contarDistintos(lista.filter((e) => e.actorTipo !== "admin"), "actorUid"),
    adminsActivos: contarDistintos(lista.filter((e) => e.actorTipo === "admin"), "actorUid"),
    pctErrores: lista.length ? Math.round((errores / lista.length) * 1000) / 10 : null,
    cambiosConfig: lista.filter((e) => TIPOS_CONFIG.has(e.tipo)).length,
    accesosDenegados: lista.filter((e) => e.tipo === "admin_acceso_denegado").length,
  };
}

function delta(actual, previo) {
  if (actual == null || previo == null) return null;
  if (previo === 0) return actual === 0 ? 0 : null; // sin base no hay % honesto
  return Math.round(((actual - previo) / previo) * 1000) / 10;
}

function overview(todos, rango, filtros = {}) {
  const actual = filtrar(enRango(todos, rango.desde, rango.hasta), filtros);
  const k = kpis(actual);
  let deltas = null;
  if (rango.anterior) {
    const prev = kpis(filtrar(enRango(todos, rango.anterior.desde, rango.anterior.hasta), filtros));
    deltas = Object.fromEntries(Object.keys(k).map((c) => [c, delta(k[c], prev[c])]));
  }
  // Leyenda real vs simulado: siempre sobre el conjunto sin filtrar por fuente.
  const sinFuente = filtrar(enRango(todos, rango.desde, rango.hasta), { ...filtros, fuente: "todo" });
  return {
    kpis: k,
    deltas,
    porTipo: breakdown(actual, "tipo", 8).items,
    porOrigen: breakdown(actual, "origen", 10).items,
    porFuente: {
      real: sinFuente.filter((e) => e.fuente === "real").length,
      sim: sinFuente.filter((e) => e.fuente === "sim").length,
    },
  };
}

/** Serie temporal agregada por cubos; los huecos van a 0 para no dibujar líneas falsas. */
function series(todos, rango, filtros = {}, metrica = "eventos") {
  const lista = filtrar(enRango(todos, rango.desde, rango.hasta), filtros);
  // En "todo" el rango empieza en 1970: se recorta al primer evento real.
  const desde = lista.length && rango.desde.getTime() === 0 ? lista[0].ts : rango.desde;
  const claves = lista.length || rango.desde.getTime() !== 0 ? cubosDelRango(desde, rango.hasta, rango.granularidad) : [];
  const cubos = new Map(claves.map((c) => [c, { real: 0, sim: 0, errores: 0, sesiones: new Set(), usuarios: new Set() }]));
  for (const e of lista) {
    const c = claveCubo(e.ts, rango.granularidad);
    if (!cubos.has(c)) cubos.set(c, { real: 0, sim: 0, errores: 0, sesiones: new Set(), usuarios: new Set() });
    const b = cubos.get(c);
    if (e.fuente === "sim") b.sim++; else b.real++;
    if (e.resultado === "error") b.errores++;
    if (e.sesionId) b.sesiones.add(e.sesionId);
    if (e.actorUid) b.usuarios.add(e.actorUid);
  }
  const puntos = [...cubos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([clave, b]) => ({
    clave,
    eventos: b.real + b.sim,
    real: b.real,
    sim: b.sim,
    errores: b.errores,
    sesiones: b.sesiones.size,
    usuarios: b.usuarios.size,
  }));
  return { metrica, granularidad: rango.granularidad, puntos };
}

/** Mapa de calor día de la semana × hora (UTC) de la actividad. */
function calor(lista) {
  const m = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of lista) m[(e.ts.getUTCDay() + 6) % 7][e.ts.getUTCHours()]++;
  return m;
}

const FUNNELS = {
  registro: ["pagina_vista", "registro_iniciado", "registro_completado", "login_exitoso"],
  reserva: ["busqueda", "restaurante_visto", "reserva_iniciada", "reserva_creada", "reserva_completada"],
};

/** Embudos por sesión: una sesión cuenta en un paso si llegó a él y a todos los anteriores. */
function funnels(lista) {
  const porSesion = new Map();
  for (const e of lista) {
    const k = e.sesionId || e.anonId || e.actorUid;
    if (!k) continue;
    if (!porSesion.has(k)) porSesion.set(k, new Set());
    porSesion.get(k).add(e.tipo);
  }
  const out = {};
  for (const [nombre, pasos] of Object.entries(FUNNELS)) {
    out[nombre] = pasos.map((paso, i) => ({
      paso,
      sesiones: [...porSesion.values()].filter((s) => pasos.slice(0, i + 1).every((p) => s.has(p))).length,
    }));
  }
  return out;
}

/** Resumen por usuario (no admins) con su última actividad. */
function usuarios(lista) {
  const m = new Map();
  for (const e of lista) {
    if (!e.actorUid || e.actorTipo === "admin" || e.actorTipo === "sistema") continue;
    const u = m.get(e.actorUid) || { uid: e.actorUid, nombre: null, fuente: e.fuente, eventos: 0, ultimaActividad: null, ultimoLogin: null, dispositivo: null };
    u.eventos++;
    u.nombre = e.actorNombre || u.nombre;
    if (!u.ultimaActividad || e.ts > u.ultimaActividad) { u.ultimaActividad = e.ts; u.dispositivo = e.dispositivo?.tipo || u.dispositivo; }
    if (/^login_(exitoso|google)$/.test(e.tipo) && (!u.ultimoLogin || e.ts > u.ultimoLogin)) u.ultimoLogin = e.ts;
    m.set(e.actorUid, u);
  }
  return [...m.values()].sort((a, b) => b.ultimaActividad - a.ultimaActividad);
}

/** Paginación por cursor sobre la lista ya ordenada (más recientes primero). */
function paginar(lista, { limite = 50, cursor = null } = {}) {
  const lim = Math.min(Math.max(Number(limite) || 50, 1), 500);
  const orden = [...lista].sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
  let inicio = 0;
  if (cursor) {
    const i = orden.findIndex((e) => e.id === cursor);
    inicio = i >= 0 ? i + 1 : 0;
  }
  const pagina = orden.slice(inicio, inicio + lim);
  const siguiente = inicio + lim < orden.length ? pagina[pagina.length - 1]?.id : null;
  return { total: orden.length, items: pagina, cursor: siguiente };
}

module.exports = { DIMENSIONES, valorDe, enRango, filtrar, breakdown, kpis, overview, series, calor, funnels, usuarios, paginar, FUNNELS };
