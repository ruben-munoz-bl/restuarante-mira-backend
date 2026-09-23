const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  PROJECT_ID: z.string().default("restaurante-mira-18e0c"),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  CPC_CLICK: z.coerce.number().default(0.20),
  CPC_VIEW: z.coerce.number().default(0),
  PUNTOS_RESERVA_BASE: z.coerce.number().default(100),
  MULTIPLICADOR_RACHA: z.coerce.number().default(1.2),
  PUNTOS_LOGIN_BASE: z.coerce.number().default(5),
  PUNTOS_LOGIN_INCREMENTO: z.coerce.number().default(3),
  PUNTOS_LOGIN_CAP: z.coerce.number().default(15),
  PUNTOS_LOGIN_GRACE_MAX: z.coerce.number().default(2),
  PUNTOS_INVITACION: z.coerce.number().default(200),
  INVITACIONES_MAX_MES: z.coerce.number().default(5),
  INVITACIONES_RESERVAS_REQUERIDAS: z.coerce.number().default(2),
  PUNTOS_REVIEW: z.coerce.number().default(20),
  PUNTOS_PROMO_VIEW: z.coerce.number().default(2),
  PUNTOS_PROMO_CLICK: z.coerce.number().default(5),
  PUNTOS_TO_EURO: z.coerce.number().default(0.01),
  MIN_PRECIO_DESCUENTO: z.coerce.number().default(20),
  COMISION_PCT: z.coerce.number().default(8),
  TICKET_PRECIO_EURO: z.coerce.number().default(18),
  TICKET_PRECIO_EURO_MID: z.coerce.number().default(32),
  TICKET_PRECIO_EURO_HIGH: z.coerce.number().default(55),
  AUTO_COMPLETE_HOURS: z.coerce.number().default(2),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid env vars:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = { env: parsed.data };
