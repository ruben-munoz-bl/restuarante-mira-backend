const { z } = require('zod');
const texto = z.string().max(4000).optional();
const restaurantUpdateSchema = z.object({
  nombre: z.string().trim().min(1).max(200).optional(),
  direccion: texto, telefono: z.string().max(40).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  horarios: z.union([z.string().max(4000), z.record(z.string().max(200))]).optional(),
  activo: z.boolean().optional(), ciudad: texto, zona: texto,
  precio: z.enum(['€', '€€', '€€€']).optional(), cocina: texto, descripcion: texto,
  comisionPct: z.number().min(0).max(100).optional(),
  maxReservasPorHora: z.number().int().min(1).max(1000).optional(),
}).strip();
const precioSchema = z.object({ precioBase: z.number().finite().positive().optional() }).strict().default({});
const estadoSchema = z.object({
  status: z.enum(['pendiente', 'confirmada', 'cancelada', 'completada', 'no_show']),
  precioBase: z.number().finite().positive().optional(),
}).strict();
const ticketSchema = z.object({
  totalPagado: z.union([z.number().positive(), z.string().regex(/^\d+(?:[.,]\d{1,2})?$/)]),
  asistio: z.boolean().optional(), fileName: z.string().max(300).optional(),
  tipoDocumento: z.string().max(100).optional(),
}).strict();
module.exports = { restaurantUpdateSchema, precioSchema, estadoSchema, ticketSchema };
