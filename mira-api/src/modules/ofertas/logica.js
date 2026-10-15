/**
 * Reglas puras de las ofertas por distancia (contrato fase 1, bóveda:
 * Proyecto/Contratos API.md). Sin Firestore: se prueban con node --test.
 */
const { z } = require("zod");
const { documentoId, fechaCalendario } = require("../../middlewares/inputSchemas");

/** Niveles fijos, de lejos a cerca. El de 20 m es el de la llegada (QR, fase 3). */
const DISTANCIAS = [1000, 500, 100, 20];

const nivelSchema = z.object({
  distancia: z.number().int(),
  texto: z.string().trim().min(1).max(140),
  descuentoPct: z.number().int().min(0).max(100),
}).strict();

/** Los niveles van en el orden fijo y nunca empeoran al acercarse. */
function erroresNiveles(niveles) {
  if (niveles.length !== DISTANCIAS.length || niveles.some((n, i) => n.distancia !== DISTANCIAS[i])) {
    return "Tienen que ser 4 niveles: 1000, 500, 100 y 20 m, en ese orden";
  }
  const empeora = niveles.some((n, i) => i > 0 && n.descuentoPct < niveles[i - 1].descuentoPct);
  if (empeora || niveles[3].descuentoPct <= niveles[0].descuentoPct) {
    return "Cada nivel tiene que ser igual o mejor que el anterior, y el de 20 m mejor que el de 1000 m";
  }
  return null;
}

const camposEditables = {
  titulo: z.string().trim().min(1).max(80),
  activa: z.boolean(),
  desde: fechaCalendario.nullable().optional(),
  hasta: fechaCalendario.nullable().optional(),
  niveles: z.array(nivelSchema),
};

function conReglas(schema) {
  return schema.superRefine((d, ctx) => {
    const error = erroresNiveles(d.niveles);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["niveles"], message: error });
    if (d.desde && d.hasta && d.desde > d.hasta) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hasta"], message: "No puede ser anterior a desde" });
    }
  });
}

const crearSchema = conReglas(z.object({ restauranteId: documentoId, ...camposEditables }).strict());
const editarSchema = conReglas(z.object(camposEditables).strict());

/** Fecha de hoy en Madrid (AAAA-MM-DD), la misma zona que el resto de la API. */
function hoyMadrid(ahora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(ahora);
}

/** Activa y dentro de su vigencia (desde y hasta incluidos). */
function vigente(oferta, hoy = hoyMadrid()) {
  return Boolean(oferta.activa) && (!oferta.desde || oferta.desde <= hoy) && (!oferta.hasta || oferta.hasta >= hoy);
}

module.exports = { DISTANCIAS, erroresNiveles, crearSchema, editarSchema, hoyMadrid, vigente };
