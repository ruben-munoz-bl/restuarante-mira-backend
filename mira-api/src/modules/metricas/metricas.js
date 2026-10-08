/**
 * Carga en directo de la API, solo en memoria (0 lecturas/escrituras de Firestore):
 * peticiones por segundo, latencia p50/p95, errores, peticiones en curso,
 * clientes activos, rutas más pedidas y salud del proceso (memoria, CPU y
 * retardo del event loop). Guarda los últimos 5 minutos en cubos de 1 s.
 *
 * Se reinicia con el proceso: es para mirar la carga "ahora", no un histórico
 * (eso es la Auditoría).
 */
const crypto = require("crypto");
const os = require("os");
const { monitorEventLoopDelay } = require("perf_hooks");

const VENTANA_S = 300;
const MUESTRAS_POR_CUBO = 200;
const EXCLUIDAS = [/^\/health$/, /^\/v1\/metricas\//, /\/stream$/];

let cubos = new Map(); // segundo → { n, e4, e5, ms: [] }
let rutas = new Map(); // "GET /v1/x/:id" → { n, errores, ms: [] }
let clientes = new Map(); // hash → último ms visto
let enCurso = 0;
let total = 0;
const inicio = Date.now();
let cpuPrevio = process.cpuUsage();
let cpuPrevioEn = Date.now();

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

function cuboDe(seg) {
  let c = cubos.get(seg);
  if (!c) {
    c = { n: 0, e4: 0, e5: 0, ms: [] };
    cubos.set(seg, c);
    const minimo = seg - VENTANA_S;
    for (const k of cubos.keys()) if (k < minimo) cubos.delete(k);
  }
  return c;
}

function percentil(valores, p) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return Math.round(orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))]);
}

/** Muestra acotada: con mucho tráfico se reemplaza al azar (reservoir) para no crecer sin límite. */
function anotar(lista, valor, max) {
  if (lista.length < max) lista.push(valor);
  else lista[Math.floor(Math.random() * max)] = valor;
}

function middlewareMetricas(req, res, next) {
  if (EXCLUIDAS.some((r) => r.test(req.path))) return next();
  const t0 = process.hrtime.bigint();
  enCurso++;
  const cliente = crypto.createHash("sha1").update(`${req.ip}|${req.headers["user-agent"] || ""}`).digest("hex").slice(0, 12);
  let cerrado = false;
  const fin = () => {
    if (cerrado) return;
    cerrado = true;
    enCurso = Math.max(0, enCurso - 1);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const ahora = Date.now();
    const c = cuboDe(Math.floor(ahora / 1000));
    c.n++;
    if (res.statusCode >= 500) c.e5++;
    else if (res.statusCode >= 400) c.e4++;
    anotar(c.ms, ms, MUESTRAS_POR_CUBO);
    total++;
    clientes.set(cliente, ahora);
    // Ruta con parámetros (/v1/restaurants/:id) para agrupar; sin req.route, el path recortado.
    const camino = req.route ? `${req.baseUrl || ""}${req.route.path}` : req.path.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, "/:id");
    const ruta = `${req.method} ${camino.replace(/(.)\/$/, "$1")}`.slice(0, 120);
    const r = rutas.get(ruta) || { n: 0, errores: 0, ms: [] };
    r.n++;
    if (res.statusCode >= 400) r.errores++;
    anotar(r.ms, ms, 300);
    rutas.set(ruta, r);
    if (rutas.size > 300) rutas.delete(rutas.keys().next().value);
  };
  res.on("finish", fin);
  res.on("close", fin);
  next();
}

/** Instantánea para el panel: serie de los últimos `segundos` y resumen. */
function instantanea(segundos = VENTANA_S) {
  const ahora = Date.now();
  const segAhora = Math.floor(ahora / 1000);
  const serie = [];
  const todas = [];
  let n = 0;
  let e4 = 0;
  let e5 = 0;
  for (let s = segAhora - Math.min(segundos, VENTANA_S) + 1; s <= segAhora; s++) {
    const c = cubos.get(s);
    serie.push({ t: s * 1000, rps: c ? c.n : 0, e4: c ? c.e4 : 0, e5: c ? c.e5 : 0, p50: c ? percentil(c.ms, 50) : null, p95: c ? percentil(c.ms, 95) : null });
    if (c) {
      n += c.n; e4 += c.e4; e5 += c.e5;
      for (const m of c.ms) todas.push(m);
    }
  }
  for (const [k, visto] of clientes) if (ahora - visto > 60000) clientes.delete(k);

  const cpu = process.cpuUsage(cpuPrevio);
  const transcurrido = (ahora - cpuPrevioEn) * 1000;
  cpuPrevio = process.cpuUsage();
  cpuPrevioEn = ahora;
  const mem = process.memoryUsage();
  const ultimos10 = serie.slice(-10).reduce((a, p) => a + p.rps, 0) / 10;

  return {
    generadoEn: new Date(ahora).toISOString(),
    ventanaS: serie.length,
    serie,
    resumen: {
      rpsActual: Math.round(ultimos10 * 10) / 10,
      peticiones: n,
      pctErrores: n ? Math.round(((e4 + e5) / n) * 1000) / 10 : null,
      errores4xx: e4,
      errores5xx: e5,
      p50: percentil(todas, 50),
      p95: percentil(todas, 95),
      p99: percentil(todas, 99),
      enCurso,
      clientesActivos: clientes.size,
      totalDesdeArranque: total,
    },
    rutas: [...rutas.entries()]
      .map(([ruta, r]) => ({ ruta, n: r.n, errores: r.errores, p95: percentil(r.ms, 95) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
    sistema: {
      memoriaMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      cpuPct: transcurrido > 0 ? Math.min(100, Math.round(((cpu.user + cpu.system) / transcurrido) * 1000) / 10) : null,
      lagMs: Math.round(lag.mean / 1e6 * 10) / 10,
      lagP99Ms: Math.round(lag.percentile(99) / 1e6 * 10) / 10,
      carga1m: Math.round(os.loadavg()[0] * 100) / 100,
      nucleos: os.cpus().length,
      uptimeS: Math.round((ahora - inicio) / 1000),
      node: process.version,
    },
  };
}

function _reset() {
  cubos = new Map();
  rutas = new Map();
  clientes = new Map();
  enCurso = 0;
  total = 0;
}

module.exports = { middlewareMetricas, instantanea, percentil, _reset };
