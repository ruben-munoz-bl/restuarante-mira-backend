const { z } = require("zod");
const documentoId = z.string().trim().min(1).max(200).refine((s) => !s.includes("/"));
const fechaCalendario = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const fecha = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === s;
}, "Fecha de calendario no válida");
const horaReserva = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const fechaPromocion = z.union([fechaCalendario, z.string().datetime({ offset: true }).refine((s) => fechaCalendario.safeParse(s.slice(0, 10)).success)]);
const alergias = z.array(z.enum(["gluten", "lactosa", "huevo", "frutos_secos", "marisco", "pescado", "soja"])).max(7);
const preferencias = z.object({
  vegano: z.boolean().optional(), soloVegano: z.boolean().optional(),
  vegetariano: z.boolean().optional(), sinGluten: z.boolean().optional(),
  alergias: alergias.optional(),
}).strict();
const accesibilidad = z.object({ sillaRuedas: z.boolean().optional(), tea: z.boolean().optional() }).strict();
const consentimientoCookies = z.object({
  necesarias: z.literal(true).optional(), preferencias: z.boolean().optional(),
  analiticas: z.boolean().optional(), marketing: z.boolean().optional(),
  timestamp: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
// C01: mismo patrón estricto y fecha con offset que consentimientoCookies.
const consentimientoPermiso = z.object({
  estado: z.enum(["aceptado", "rechazado"]),
  version: z.number().int().min(1).max(1000),
  fecha: z.string().datetime({ offset: true }),
}).strict();
const consentimientos = z.object({
  ubicacion: consentimientoPermiso.optional(),
  notificaciones: consentimientoPermiso.optional(),
}).strict();
module.exports = { documentoId, fechaCalendario, horaReserva, fechaPromocion, alergias, preferencias, accesibilidad, consentimientoCookies, consentimientos };
