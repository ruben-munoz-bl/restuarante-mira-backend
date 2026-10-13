const DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173";

const LOCALES = new Set(DEFAULT_CORS_ORIGINS.split(","));

/**
 * Política anterior, usada si CORS_ALLOWED_ORIGINS no está configurada en Render:
 * localhost + cualquier *.vercel.app. Así desplegar sin tocar la configuración no
 * deja la web de Vercel sin API. Para endurecerlo, basta con definir la variable.
 */
function politicaCompatible(origen) {
  if (!origen || LOCALES.has(origen)) return true;
  try {
    const u = new URL(origen);
    return u.protocol === "https:" && (u.hostname === "vercel.app" || u.hostname.endsWith(".vercel.app"));
  } catch {
    return false;
  }
}

function crearPoliticaCors(valor) {
  if (!valor || !valor.trim()) return politicaCompatible;
  const permitidos = new Set();
  for (const origen of valor.split(",").map((s) => s.trim()).filter(Boolean)) {
    const url = new URL(origen);
    if (!["http:", "https:"].includes(url.protocol) || origen.includes("*") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("CORS_ALLOWED_ORIGINS requiere orígenes HTTP(S) explícitos, sin comodines ni rutas");
    }
    permitidos.add(url.origin);
  }
  return (origen) => !origen || permitidos.has(origen);
}

module.exports = { crearPoliticaCors, DEFAULT_CORS_ORIGINS };
