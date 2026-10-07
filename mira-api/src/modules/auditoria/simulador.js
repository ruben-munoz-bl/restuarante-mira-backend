/**
 * Simulador de 100 usuarios para la auditoría. Lo usan el endpoint
 * POST /v1/auditoria/sim/run y el script yelp-connection/simular-auditoria.js,
 * así ambos escriben exactamente lo mismo.
 *
 * - Generación determinista a partir de una semilla (sin dependencias: el
 *   PRNG y las listas de nombres viven aquí; no hace falta faker en la API).
 * - Timestamps retroactivos repartidos en los últimos `dias` días, con picos
 *   en comida (13-15 h) y cena (20-22 h) y una curva de crecimiento: si todo
 *   cayera hoy, las vistas por día/semana/mes saldrían planas.
 * - Todo lleva fuente:'sim' y simRunId, y pasa por validarEvento() igual que
 *   los eventos reales.
 */
const { validarEvento } = require("./esquema");

const NOMBRES = ["Laura", "Jordi", "Marta", "Pau", "Anna", "Marc", "Clara", "Sergi", "Núria", "Albert", "Elena", "Oriol",
  "Júlia", "David", "Laia", "Carlos", "Emma", "Lucas", "Sofia", "Hugo", "Paula", "Álex", "Irene", "Bruno"];
const APELLIDOS = ["Martí", "Puig", "Soler", "Ferrer", "Vidal", "Roca", "Font", "Mas", "Pons", "Camps", "Serra", "Riba",
  "Costa", "Bosch", "Torres", "Ruiz", "García", "López"];
const ZONAS = [
  { ciudad: "Barcelona", barrios: ["Gràcia", "Eixample", "Born", "Poblenou", "Sants", "Barceloneta"] },
  { ciudad: "Tarragona", barrios: ["Part Alta", "Serrallo"] },
  { ciudad: "Girona", barrios: ["Barri Vell", "Eixample"] },
  { ciudad: "Lleida", barrios: ["Centre Històric"] },
];
const BUSQUEDAS = ["paella", "sushi", "tapas", "vegano", "brunch", "pizza", "arroz negro", "calçots", "terraza", "menú del día",
  "marisco", "ramen", "sin gluten", "hamburguesa", "cocina catalana", "xqzv"];
const FACETAS = [["precio", ["€", "€€", "€€€"]], ["cocina", ["mediterránea", "japonesa", "italiana", "vegana", "catalana"]],
  ["distancia", ["1km", "3km", "5km"]], ["valoracion", ["4+", "4.5+"]]];
const ORDENES = ["valoracion", "distancia", "precio_asc", "popularidad"];
const RESTAURANTES = [["r-can-sole", "Can Solé"], ["r-taverna-port", "La Taverna del Port"], ["r-celler-gracia", "El Celler de Gràcia"],
  ["r-mar-muntanya", "Mar i Muntanya"], ["r-sushi-born", "Sushi Born"], ["r-brasa-lleida", "Brasa Lleida"],
  ["r-trattoria-sitges", "Trattoria Sitges"], ["r-casa-mila", "Casa Mila Tapas"]];
const DISPOSITIVOS = [
  { tipo: "mobile", os: "iOS", navegador: "Safari", pantalla: { ancho: 390, alto: 844, dpr: 3 }, touch: true },
  { tipo: "mobile", os: "Android", navegador: "Chrome", pantalla: { ancho: 412, alto: 915, dpr: 2.6 }, touch: true },
  { tipo: "mobile", os: "Android", navegador: "Samsung Internet", pantalla: { ancho: 360, alto: 780, dpr: 3 }, touch: true },
  { tipo: "tablet", os: "iPadOS", navegador: "Safari", pantalla: { ancho: 820, alto: 1180, dpr: 2 }, touch: true },
  { tipo: "desktop", os: "macOS", navegador: "Chrome", pantalla: { ancho: 1440, alto: 900, dpr: 2 }, touch: false },
  { tipo: "desktop", os: "Windows", navegador: "Edge", pantalla: { ancho: 1920, alto: 1080, dpr: 1 }, touch: false },
];
const PAISES = ["ES", "ES", "ES", "ES", "FR", "DE", "GB", "IT", "NL", "US"];
const ADMINS = [
  { uid: "sim-admin-1", nombre: "Admin Sara (sim)" },
  { uid: "sim-admin-2", nombre: "Admin Toni (sim)" },
  { uid: "sim-admin-3", nombre: "Admin Rut (sim)" },
];

const DIA = 86400000;
const HORA = 3600000;

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function semillaDe(texto) {
  let h = 2166136261;
  for (const c of String(texto)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Genera los eventos de una ejecución. Devuelve { eventos, resumen } sin escribir nada.
 * `hoy` fija el final del rango (tests deterministas).
 */
function generarSimulacion({ simRunId, usuarios = 100, dias = 30, hoy = new Date() } = {}) {
  const r = prng(semillaDe(simRunId || "sim"));
  const elegir = (arr) => arr[Math.floor(r() * arr.length)];
  const fin = hoy.getTime();
  const inicio = fin - dias * DIA;
  const eventos = [];

  /** Día con curva de crecimiento: más probable cuanto más reciente. */
  const diaCreciente = () => Math.floor(Math.sqrt(r()) * dias);
  /** Hora local con picos de comida y cena (se guarda en UTC: Cataluña ≈ UTC+2). */
  const horaPunta = (perfil) => {
    const x = r();
    if (x < 0.4) return 13 + r() * 2;
    if (x < 0.85) return 20 + r() * 2;
    return perfil === "turista" ? 10 + r() * 8 : 9 + r() * 14;
  };

  for (let i = 0; i < usuarios; i++) {
    const nombre = `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`;
    const zona = elegir(ZONAS);
    const perfil = r() < 0.3 ? "turista" : "local";
    const dispositivo = { ...(r() < 0.72 ? DISPOSITIVOS[Math.floor(r() * 3)] : elegir(DISPOSITIVOS.slice(3))), lang: perfil === "turista" ? "en" : r() < 0.5 ? "ca" : "es", zonaHoraria: "Europe/Madrid", pais: perfil === "turista" ? elegir(PAISES.slice(4)) : "ES" };
    const uid = `sim-u-${String(i + 1).padStart(3, "0")}`;
    const anonId = `sim-anon-${String(i + 1).padStart(3, "0")}`;
    let registrado = r() < 0.35; // ya tenía cuenta antes de la simulación
    const sesiones = 1 + (r() < 0.45 ? 1 : 0) + (r() < 0.15 ? 1 : 0);

    for (let s = 0; s < sesiones; s++) {
      const dia = diaCreciente();
      const hora = horaPunta(perfil);
      let t = inicio + dia * DIA + (hora - 2) * HORA;
      if (t > fin) t = fin - r() * 6 * HORA;
      const sesionId = `${simRunId}-s${i}-${s}`;
      let logueado = false;
      const ev = (tipo, extra = {}) => {
        t += (4 + r() * 50) * 1000;
        eventos.push({
          tipo, origen: "app", anonId, sesionId, ruta: extra.ruta || "#/", pagina: extra.pagina || "inicio",
          actorUid: logueado ? uid : null, actorNombre: logueado ? nombre : null, actorTipo: logueado ? "usuario" : null,
          dispositivo, ts: new Date(Math.min(t, fin)), ...extra,
        });
      };

      ev("sesion_iniciada");
      ev("pagina_vista", { datos: { zona: zona.ciudad, barrio: elegir(zona.barrios), perfil } });
      if (r() < 0.6) ev("scroll_profundidad", { meta: { valor: elegir([25, 50, 75, 100]) } });
      if (r() < 0.12) { ev("enlace_salida", { datos: { destino: "instagram" } }); ev("sesion_cerrada"); continue; } // abandono temprano

      const consulta = elegir(BUSQUEDAS);
      const resultados = consulta === "xqzv" ? 0 : 3 + Math.floor(r() * 40);
      ev("busqueda", { pagina: "buscar", ruta: "#/", datos: { consulta, consultaNorm: consulta.normalize("NFD").replace(/[̀-ͯ]/g, ""), resultados, vacio: resultados === 0 }, meta: { duracionMs: 80 + Math.floor(r() * 600) } });
      if (resultados === 0) { ev("sesion_cerrada"); continue; }
      for (let f = 0; f < Math.floor(r() * 3); f++) {
        const [faceta, valores] = elegir(FACETAS);
        ev("filtro_aplicado", { pagina: "buscar", datos: { faceta, valor: elegir(valores) } });
      }
      if (r() < 0.4) ev("orden_cambiado", { pagina: "buscar", datos: { orden: elegir(ORDENES) } });
      if (r() < 0.25) ev("paginacion", { pagina: "buscar", meta: { valor: 2 } });
      if (r() < 0.3) ev("mapa_marcador_pulsado", { pagina: "mapa", ruta: "#/mapa" });

      const [rid, rnombre] = elegir(RESTAURANTES);
      const ent = { entidadTipo: "restaurante", entidadId: rid, entidadNombre: rnombre, pagina: "ficha", ruta: `#/restaurante/${rid}` };
      ev("restaurante_pulsado", ent);
      ev("restaurante_visto", ent);
      if (r() < 0.55) ev("carta_abierta", ent);
      if (r() < 0.5) ev("resena_vista", ent);
      if (r() < 0.15) ev("compartir", { ...ent, datos: { canal: elegir(["whatsapp", "copiar", "email"]) } });
      if (r() < 0.2) ev("promo_vista", ent);

      // Login / registro (a veces falla)
      if (r() < 0.75) {
        if (!registrado && r() < 0.6) {
          ev("registro_iniciado", { pagina: "registro", ruta: "#/registro" });
          if (r() < 0.8) {
            logueado = true;
            registrado = true;
            ev("registro_completado", { pagina: "registro", ruta: "#/registro" });
            if (r() < 0.7) ev("email_verificado");
          }
        } else if (registrado) {
          if (r() < 0.12) ev("login_fallido", { pagina: "login", ruta: "#/login", resultado: "error", codigoError: "auth/wrong-password" });
          logueado = true;
          ev(r() < 0.3 ? "login_google" : "login_exitoso", { pagina: "login", ruta: "#/login" });
        }
      }

      if (logueado) {
        if (r() < 0.6) {
          ev("reserva_iniciada", ent);
          if (r() < 0.8) {
            ev("reserva_creada", { ...ent, datos: { comensales: 2 + Math.floor(r() * 5), franja: hora < 17 ? "comida" : "cena" } });
            const fin2 = r();
            if (fin2 < 0.55) ev("reserva_completada", ent);
            else if (fin2 < 0.7) ev("reserva_cancelada", ent);
            else if (fin2 < 0.78) ev("reserva_no_show", ent);
            if (r() < 0.4) ev("puntos_ganados", { meta: { cantidad: 100 } });
          }
        }
        if (r() < 0.35) ev("favorito_añadido", ent);
        if (r() < 0.25) ev("rueda_girada", { pagina: "puntos", ruta: "#/puntos", meta: { valor: elegir([5, 10, 25, 50]) } });
        if (r() < 0.12) ev("puntos_canjeados", { pagina: "puntos", meta: { cantidad: elegir([100, 250, 500]) } });
        if (r() < 0.1) ev("invitación_enviada", { pagina: "invitar", ruta: "#/invitar" });
        if (r() < 0.3) {
          ev("mira_abierta");
          ev("mira_mensaje", { meta: { cantidad: 1 + Math.floor(r() * 4) } });
          if (r() < 0.3) ev("mira_feedback", { datos: { util: r() < 0.8 } });
        }
        if (r() < 0.3) ev("cierre_sesion");
      }
      ev("sesion_cerrada");
    }
  }

  // Acciones de administración (2-3 admins) para la sub-pestaña Administración.
  const accionesAdmin = [
    () => { const [id, n] = elegir(RESTAURANTES); const a = 6 + Math.floor(r() * 4); return { tipo: "restaurante_editado", entidadTipo: "restaurante", entidadId: id, entidadNombre: n, cambios: [{ campo: "maxReservasPorHora", antes: a, despues: a + 2 }] }; },
    () => { const u = `sim-u-${String(1 + Math.floor(r() * usuarios)).padStart(3, "0")}`; const a = Math.floor(r() * 300); const c = elegir([50, 100, -20]); return { tipo: "puntos_abonados", entidadTipo: "usuario", entidadId: u, cambios: [{ campo: "saldoPuntos", antes: a, despues: a + c }], meta: { cantidad: c } }; },
    () => { const u = `sim-u-${String(1 + Math.floor(r() * usuarios)).padStart(3, "0")}`; const a = Math.floor(r() * 6); return { tipo: "racha_modificada", entidadTipo: "usuario", entidadId: u, cambios: [{ campo: "rachaLoginDias", antes: a, despues: a + 1 }] }; },
    () => ({ tipo: "reserva_estado_cambiada", entidadTipo: "reserva", entidadId: `sim-res-${Math.floor(r() * 9000)}`, cambios: [{ campo: "estado", antes: "pendiente", despues: elegir(["confirmada", "cancelada"]) }] }),
    () => ({ tipo: "incidencia_resuelta", entidadTipo: "incidencia", entidadId: `sim-inc-${Math.floor(r() * 900)}`, cambios: [{ campo: "estado", antes: "pendiente", despues: "resuelta" }] }),
    () => ({ tipo: "negocio_aprobado", entidadTipo: "negocio", entidadId: `sim-neg-${Math.floor(r() * 90)}`, cambios: [{ campo: "estado", antes: "pendiente", despues: "aprobado" }] }),
    () => ({ tipo: "ajustes_cambiados", entidadTipo: "ajustes", entidadId: "auditoria", cambios: [{ campo: "excluirPropio", antes: false, despues: true }] }),
  ];
  for (const admin of ADMINS) {
    const n = 8 + Math.floor(r() * 8);
    for (let k = 0; k < n; k++) {
      const t = inicio + diaCreciente() * DIA + (8 + r() * 10) * HORA;
      const base = { origen: "panel", actorUid: admin.uid, actorNombre: admin.nombre, actorTipo: "admin", sesionId: `${simRunId}-${admin.uid}-${k}`, pagina: "admin", ruta: "#/admin", dispositivo: DISPOSITIVOS[4] };
      eventos.push({ ...base, tipo: "admin_login", ts: new Date(Math.min(t, fin)) });
      eventos.push({ ...base, ...elegir(accionesAdmin)(), ts: new Date(Math.min(t + 90000, fin)) });
    }
  }
  eventos.push({ origen: "api", tipo: "admin_acceso_denegado", actorUid: "sim-u-007", actorTipo: "usuario", ruta: "/v1/dashboard/users", resultado: "error", codigoError: "FORBIDDEN", ts: new Date(fin - 3 * DIA) });

  const validos = [];
  for (const e of eventos) {
    const { ts, actorUid, actorNombre, actorTipo, origen } = e;
    const v = validarEvento({ ...e, origen: origen === "panel" ? "panel" : "app", ts: undefined });
    if (!v.evento) continue;
    // `pais` lo deriva el servidor en los eventos reales (no viene del cliente), así que se repone tras validar.
    const dispositivo = v.evento.dispositivo ? { ...v.evento.dispositivo, pais: e.dispositivo?.pais || null } : null;
    validos.push({ ...v.evento, dispositivo, ts, origen, actorUid: actorUid || null, actorNombre: actorNombre || null, actorTipo: actorTipo || null, fuente: "sim", simRunId });
  }
  validos.sort((a, b) => a.ts - b.ts);
  return { eventos: validos, resumen: resumir(validos) };
}

function resumir(eventos) {
  const dias = new Set(eventos.map((e) => e.ts.toISOString().slice(0, 10)));
  const { claveSemanaISO } = require("./esquema");
  const semanas = new Set(eventos.map((e) => claveSemanaISO(e.ts)));
  return {
    eventos: eventos.length,
    sesiones: new Set(eventos.map((e) => e.sesionId).filter(Boolean)).size,
    usuarios: new Set(eventos.map((e) => e.anonId || e.actorUid).filter(Boolean)).size,
    dias: dias.size,
    semanas: semanas.size,
  };
}

/** Escribe en lotes de 500 con hasta 3 reintentos por lote. `alProgresar(escritos, total)`. */
async function escribirEnLotes(db, coleccion, eventos, alProgresar = () => {}) {
  const escritos = [];
  for (let i = 0; i < eventos.length; i += 500) {
    const trozo = eventos.slice(i, i + 500);
    let intento = 0;
    for (;;) {
      try {
        const lote = db.batch();
        const conId = trozo.map((e) => {
          const ref = db.collection(coleccion).doc();
          const doc = { ...e, insertadoEn: new Date() };
          lote.set(ref, limpiarUndefined(doc));
          return { ...doc, id: ref.id };
        });
        await lote.commit();
        escritos.push(...conId);
        break;
      } catch (err) {
        if (++intento >= 3) throw err;
        await new Promise((res) => setTimeout(res, 500 * 2 ** intento));
      }
    }
    alProgresar(escritos.length, eventos.length);
  }
  return escritos;
}

/** Firestore rechaza `undefined`. */
function limpiarUndefined(obj) {
  if (Array.isArray(obj)) return obj.map(limpiarUndefined);
  if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = limpiarUndefined(v);
    return out;
  }
  return obj;
}

module.exports = { generarSimulacion, escribirEnLotes, limpiarUndefined, resumir };
