const { z } = require("zod");
const { db } = require("../../middlewares/verifyFirebaseAuth");
const { hoyMadrid } = require("../ofertas/logica");
const entero = (max, defecto) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(max)).default(String(defecto));
const rankingSchema = z.object({ dias: entero(30, 7), limit: entero(20, 8) }).strict();
const TTL_MS = 30_000;
const cache = new Map();
function vaciarRanking() { cache.clear(); }
async function masReservados({ dias = 7, limit = 8 } = {}) {
  const hoy = hoyMadrid();
  const inicio = new Date(`${hoy}T12:00:00Z`);
  inicio.setUTCDate(inicio.getUTCDate() - dias + 1);
  const desde = inicio.toISOString().slice(0, 10);
  const clave = `${desde}:${hoy}`;
  const ahora = Date.now();
  for (const [key, value] of cache) if (ahora - value.at >= TTL_MS || !key.endsWith(`:${hoy}`)) cache.delete(key);
  let entrada = cache.get(clave);
  if (!entrada) {
    const promesa = (async () => {
      // El rango se filtra en Firestore, no en memoria. Solo se leen campos
      // necesarios para contar; no se consultan perfiles ni el catálogo.
      const snap = await db.collection("reservas").where("fecha", ">=", desde).where("fecha", "<=", hoy)
        .select("restaurantId", "restauranteId", "estado").get();
      const cuentas = new Map();
      for (const doc of snap.docs) {
        const d = doc.data();
        const id = d.restaurantId || d.restauranteId;
        if (d.estado !== "cancelada" && typeof id === "string" && id) cuentas.set(id, (cuentas.get(id) || 0) + 1);
      }
      return [...cuentas].map(([id, reservas]) => ({ id, reservas }))
        .sort((a, b) => b.reservas - a.reservas || a.id.localeCompare(b.id));
    })();
    entrada = { at: ahora, promesa }; cache.set(clave, entrada);
    promesa.catch(() => { if (cache.get(clave) === entrada) cache.delete(clave); });
  }
  return (await entrada.promesa).slice(0, limit);
}
module.exports = { rankingSchema, masReservados, vaciarRanking };
