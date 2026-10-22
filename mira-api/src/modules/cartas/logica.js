const { z } = require("zod");
const { alergias } = require("../../middlewares/inputSchemas");
const idCarta = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const plato = z.object({
  id: idCarta.optional(),
  nombre: z.string().trim().min(1).max(80),
  descripcion: z.string().max(300),
  precio: z.number().min(0.01).max(999.99).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, "Máximo dos decimales"),
  foto: z.string().url().refine(s => /^https:\/\//i.test(s), "URL HTTPS requerida").nullable().optional(),
  alergenos: alergias,
  disponible: z.boolean(),
}).strict();
const cartaSchema = z.object({ categorias: z.array(z.object({
  id: idCarta.optional(), nombre: z.string().trim().min(1).max(60), platos: z.array(plato).max(60),
}).strict()).min(1).max(30) }).strict().superRefine((data, ctx) => {
  const categorias = new Set(), platos = new Set();
  let total = 0;
  data.categorias.forEach((cat, i) => {
    if (cat.id && categorias.has(cat.id)) ctx.addIssue({ code: "custom", path: ["categorias", i, "id"], message: "ID de categoría duplicado" });
    if (cat.id) categorias.add(cat.id);
    cat.platos.forEach((p, j) => {
      total++;
      if (p.id && platos.has(p.id)) ctx.addIssue({ code: "custom", path: ["categorias", i, "platos", j, "id"], message: "ID de plato duplicado" });
      if (p.id) platos.add(p.id);
    });
  });
  if (total > 300) ctx.addIssue({ code: "custom", path: ["categorias"], message: "Máximo 300 platos" });
});
module.exports = { cartaSchema, idCarta };
