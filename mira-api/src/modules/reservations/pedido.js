const { z } = require("zod");
const { idCarta } = require("../cartas/logica");
const { fechaCalendario, documentoId } = require("../../middlewares/inputSchemas");
const { hoyMadrid } = require("../ofertas/logica");
const pedidoSchema = z.object({ lineas: z.array(z.object({ platoId: idCarta, cantidad: z.number().int().min(1).max(20) }).strict()).min(1).max(30) }).strict()
  .refine(p => new Set(p.lineas.map(l => l.platoId)).size === p.lineas.length, { message: "Plato repetido", path: ["lineas"] });
const listadoSchema = z.object({ restauranteId: documentoId, desde: fechaCalendario.optional(), hasta: fechaCalendario.optional() }).strict()
  .transform(d => ({ ...d, desde: d.desde ?? hoyMadrid(), hasta: d.hasta ?? d.desde ?? hoyMadrid() }))
  .refine(d => d.hasta >= d.desde && (Date.parse(d.hasta) - Date.parse(d.desde)) / 86400000 <= 31,
    { message: "Rango de fechas inválido (máximo 31 días)", path: ["hasta"] });

function copiarPedido(carta, pedido, ahora = new Date()) {
  if (!pedido) return null;
  if (!carta) throw Object.assign(new Error("Restaurante sin carta"), { status: 400, code: "SIN_CARTA" });
  const platos = new Map(carta.categorias.flatMap(c => c.platos).map(p => [p.id, p]));
  let centimos = 0;
  const lineas = pedido.lineas.map(l => {
    const p = platos.get(l.platoId);
    if (!p || p.disponible !== true) throw Object.assign(new Error("Plato no disponible"), { status: 400, code: "PLATO_NO_DISPONIBLE", platoId: l.platoId });
    const precioCentimos = Math.round(p.precio * 100), subtotalCentimos = precioCentimos * l.cantidad;
    centimos += subtotalCentimos;
    return { platoId: l.platoId, nombre: p.nombre, precio: precioCentimos / 100, cantidad: l.cantidad, subtotal: subtotalCentimos / 100 };
  });
  return { lineas, total: centimos / 100, moneda: "EUR", creadoEn: ahora.toISOString() };
}
module.exports = { pedidoSchema, listadoSchema, copiarPedido };
