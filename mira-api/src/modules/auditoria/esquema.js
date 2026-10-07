/**
 * Esquema y saneado de eventos de auditoría (funciones puras, testeables).
 * - El cliente nunca decide quién es el actor ni la `fuente`: eso lo pone el servidor.
 * - `datos` no admite PII: las claves sospechosas se descartan antes de guardar.
 */
const { z } = require("zod");
const { TIPOS } = require("./catalogo");

const MAX_TEXTO = 512;
const MAX_CLAVES_DATOS = 15;
const MAX_BATCH = 100;
const CLAVE_PII = /(e-?mail|correo|tel[eé]fono|phone|m[oó]vil|token|password|contrase|clave|tarjeta|card|iban|cvv|dni|nif)/i;
const VALOR_PII = /([^\s@]+@[^\s@]+\.[^\s@]+)|(\b\d{13,19}\b)|(\+?\d[\d\s-]{8,}\d)/;
// Las fechas ISO (2026-10-07T12:00:00Z) parecen un teléfono para VALOR_PII: no son datos personales.
const ES_FECHA = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;
const BOT_UA = /(bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios\/)/i;

const texto = (n = MAX_TEXTO) => z.string().max(4000).transform((s) => s.slice(0, n)).optional().nullable();

const dispositivoSchema = z.object({
  tipo: z.enum(["mobile", "tablet", "desktop"]).optional(),
  os: texto(40),
  navegador: texto(40),
  pantalla: z.object({ ancho: z.number().int().min(0).max(20000), alto: z.number().int().min(0).max(20000), dpr: z.number().min(0).max(10) }).partial().optional(),
  touch: z.boolean().optional(),
  lang: texto(20),
  zonaHoraria: texto(60),
}).partial().optional().nullable();

const eventoSchema = z.object({
  tipo: z.string().refine((t) => TIPOS.has(t), { message: "tipo fuera del catálogo" }),
  origen: z.enum(["app", "panel"]).default("app"),
  anonId: texto(64),
  sesionId: texto(64),
  ruta: texto(200),
  pagina: texto(80),
  accion: texto(80),
  entidadTipo: texto(40),
  entidadId: texto(120),
  entidadNombre: texto(160),
  datos: z.record(z.any()).optional().nullable(),
  cambios: z.array(z.object({ campo: z.string().max(80), antes: z.any(), despues: z.any() })).max(30).optional().nullable(),
  resultado: z.enum(["ok", "error"]).default("ok"),
  codigoError: texto(60),
  mensajeError: texto(),
  dispositivo: dispositivoSchema,
  meta: z.record(z.any()).optional().nullable(),
  ts: z.string().datetime().optional(), // hora del cliente: solo informativa, `ts` real = servidor
});

const batchSchema = z.object({ eventos: z.array(z.any()).min(1).max(MAX_BATCH) });

function valorPlano(v) {
  if (v == null) return null;
  if (typeof v === "string") return !ES_FECHA.test(v) && VALOR_PII.test(v) ? "[oculto]" : v.slice(0, MAX_TEXTO);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => (typeof x === "object" ? null : valorPlano(x)));
  return String(JSON.stringify(v)).slice(0, MAX_TEXTO);
}

/** Objeto plano, máx. 15 claves, sin PII. */
function limpiarDatos(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Object.keys(out).length >= MAX_CLAVES_DATOS) break;
    if (CLAVE_PII.test(k)) continue;
    out[k.slice(0, 40)] = valorPlano(v);
  }
  return Object.keys(out).length ? out : null;
}

function limpiarCambios(cambios) {
  if (!Array.isArray(cambios) || !cambios.length) return null;
  return cambios.map((c) => ({
    campo: String(c.campo).slice(0, 80),
    antes: CLAVE_PII.test(c.campo) ? "[oculto]" : valorPlano(c.antes),
    despues: CLAVE_PII.test(c.campo) ? "[oculto]" : valorPlano(c.despues),
  }));
}

function esBot(userAgent) {
  return !userAgent || BOT_UA.test(userAgent);
}

/**
 * Valida un evento crudo del cliente. Devuelve { evento } o { error }.
 * Descarta ruido: duraciones < 50 ms (dobles clics, renders) se ignoran.
 */
function validarEvento(crudo) {
  const r = eventoSchema.safeParse(crudo);
  if (!r.success) return { error: r.error.issues[0]?.message || "evento inválido" };
  const e = r.data;
  const meta = limpiarDatos(e.meta);
  if (meta && typeof meta.duracionMs === "number" && meta.duracionMs < 50) return { descartado: "duracion" };
  return {
    evento: {
      ...e,
      datos: limpiarDatos(e.datos),
      cambios: limpiarCambios(e.cambios),
      meta,
      tsCliente: e.ts || null,
      ts: undefined,
    },
  };
}

/**
 * Throttling de scroll: como mucho 1 evento scroll_profundidad cada 2 s por sesión.
 * `ultimos` es un Map(sesionId → ms) que vive en el proceso.
 */
function pasaThrottle(evento, ahora, ultimos) {
  if (evento.tipo !== "scroll_profundidad") return true;
  const clave = evento.sesionId || evento.anonId || "?";
  if (ultimos.has(clave) && ahora - ultimos.get(clave) < 2000) return false;
  ultimos.set(clave, ahora);
  if (ultimos.size > 5000) ultimos.delete(ultimos.keys().next().value);
  return true;
}

/* ───────── Periodos (todo en UTC) ───────── */

const DIA = 86400000;

function inicioDiaUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Lunes 00:00 UTC de la semana ISO de `d`. */
function inicioSemanaUTC(d) {
  const dia = inicioDiaUTC(d);
  const dow = (dia.getUTCDay() + 6) % 7; // 0 = lunes
  return new Date(dia.getTime() - dow * DIA);
}

function inicioMesUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** "2026-W41" (semana ISO 8601). */
function claveSemanaISO(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const inicioAnio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((t - inicioAnio) / DIA + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
}

/**
 * Normaliza periodo/desde/hasta a un rango UTC [desde, hasta) y su granularidad.
 * día → hoy (puntos por hora), semana → semana ISO actual (por día),
 * mes → mes actual (por día), todo → histórico (por mes). desde/hasta mandan si vienen.
 */
function normalizarPeriodo({ periodo = "mes", desde, hasta, granularidad } = {}, ahora = new Date()) {
  const p = ["dia", "semana", "mes", "todo"].includes(periodo) ? periodo : "mes";
  let d;
  if (p === "dia") d = inicioDiaUTC(ahora);
  else if (p === "semana") d = inicioSemanaUTC(ahora);
  else if (p === "mes") d = inicioMesUTC(ahora);
  else d = new Date(0);
  let h = new Date(ahora.getTime() + 1);
  const dd = desde ? new Date(desde) : null;
  const hh = hasta ? new Date(hasta) : null;
  if (dd && !Number.isNaN(dd.getTime())) d = dd;
  if (hh && !Number.isNaN(hh.getTime())) h = hh.getTime() === inicioDiaUTC(hh).getTime() && /^\d{4}-\d{2}-\d{2}$/.test(String(hasta)) ? new Date(hh.getTime() + DIA) : hh;
  const defecto = p === "dia" ? "hora" : p === "todo" ? "mes" : "dia";
  const g = ["hora", "dia", "semana", "mes"].includes(granularidad) ? granularidad : defecto;
  const largo = h.getTime() - d.getTime();
  const anterior = p === "todo" && !dd ? null : { desde: new Date(d.getTime() - largo), hasta: d };
  return { periodo: p, desde: d, hasta: h, granularidad: g, anterior };
}

/** Clave de cubo temporal para una fecha según granularidad. */
function claveCubo(fecha, granularidad) {
  const iso = fecha.toISOString();
  if (granularidad === "hora") return `${iso.slice(0, 13)}:00`;
  if (granularidad === "dia") return iso.slice(0, 10);
  if (granularidad === "semana") return claveSemanaISO(fecha);
  return iso.slice(0, 7);
}

/** Todas las claves del rango, para que los huecos salgan a 0 y no se "unan" puntos. */
function cubosDelRango(desde, hasta, granularidad) {
  const claves = [];
  const vistas = new Set();
  const paso = granularidad === "hora" ? 3600000 : DIA;
  const fin = Math.min(hasta.getTime(), Date.now() + DIA);
  for (let t = desde.getTime(); t < fin && claves.length < 2000; t += paso) {
    const k = claveCubo(new Date(t), granularidad);
    if (!vistas.has(k)) { vistas.add(k); claves.push(k); }
  }
  return claves;
}

module.exports = {
  MAX_BATCH, eventoSchema, batchSchema, validarEvento, limpiarDatos, limpiarCambios, pasaThrottle, esBot,
  normalizarPeriodo, claveCubo, cubosDelRango, claveSemanaISO, inicioSemanaUTC,
};
