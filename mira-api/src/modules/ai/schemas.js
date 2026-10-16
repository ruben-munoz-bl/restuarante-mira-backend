const { z } = require("zod");

const agentSchema = z.object({
  message: z.string().trim().min(1, "message no puede estar vacío").max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "model"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(10)
    .default([]),
  confirmId: z.string().uuid().optional(),
  // Idioma en el que la web quiere la respuesta. Opcional: sin él se responde en español.
  lang: z.enum(["es", "ca", "en"]).optional(),
});

module.exports = { agentSchema };
