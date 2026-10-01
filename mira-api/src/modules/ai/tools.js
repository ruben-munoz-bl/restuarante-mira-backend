"use strict";

const crypto = require("crypto");
const { SLOTS } = require("../../config/constants");
const { env } = require("../../config/env");

const restaurantService = require("../restaurants/service");
const reservationService = require("../reservations/service");
const pointsService = require("../points/service");
const usersService = require("../users/service");

const ROLES_PUBLICO = ["public"];
const ROLES_CLIENTE = ["cliente", "empresa", "admin"];
const ROLES_EMPRESA = ["empresa", "admin"];
const ROLES_ADMIN = ["admin"];

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const str = (description, extra) => ({ type: "STRING", description, ...(extra || {}) });
const num = (description, extra) => ({ type: "NUMBER", description, ...(extra || {}) });
const bool = (description, extra) => ({ type: "BOOLEAN", description, ...(extra || {}) });
const list = (description, items, extra) => ({ type: "ARRAY", description, items, ...(extra || {}) });
const schema = (properties, required) => ({ type: "OBJECT", properties: properties || {}, required: required || [] });

const FECHA = () => str("Fecha en formato YYYY-MM-DD.", { pattern: DATE_PATTERN });
const HORA = () => str("Franja horaria disponible.", { enum: SLOTS });

const TOOLS = [
  // ── Públicas ──────────────────────────────────────────────────────────────
  {
    name: "searchRestaurants",
    description: "Busca restaurantes por texto y filtros. cocina: etiqueta exacta en inglés (Italian, Tapas Bars, Japanese). Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: true,
    parameters: schema({
      q: str("Texto libre: nombre, cocina, ciudad o dirección (busca también en las etiquetas de cocina)."),
      cocina: str("Etiqueta exacta de cocina, en inglés y en minúscula, p. ej. \"italian\", \"tapas bars\", \"japanese\"."),
      ciudad: str("Ciudad exacta del restaurante (Barcelona, Tarragona, Girona, Lleida)."),
      zona: str("Zona de búsqueda dentro de la ciudad."),
      limit: num("Tamaño de página (1-27). Por defecto 10.", { minimum: 1, maximum: 27 }),
      cursor: str("Cursor de paginación devuelto en la página anterior."),
    }),
    handler: async (ctx, args) => {
      const a = args || {};
      const base = {
        limit: Math.min(Math.max(parseInt(a.limit, 10) || 10, 1), 27),
        all: false,
        cursor: a.cursor || null,
        ciudad: a.ciudad || null,
        zona: a.zona || null,
      };
      const cocina = (a.cocina || "").trim().toLowerCase();
      let result = await restaurantService.listarRestaurantes({ ...base, q: a.q || null, cocina: a.cocina || null });
      let match = "exacto";

      // La API filtra `cocina` con array-contains EXACTO y sensible a mayúsculas
      // ("Italian" ≠ "italian"). Si no hay resultados, reintentamos con `q`,
      // que normaliza acentos y mayúsculas y también busca en las etiquetas.
      if (!result || !result.items || result.items.length === 0) {
        const fallbackTerm = a.q || cocina;
        if (fallbackTerm) {
          const relaxed = await restaurantService.listarRestaurantes({ ...base, q: fallbackTerm, cocina: null });
          if (relaxed && relaxed.items && relaxed.items.length > 0) {
            relaxed.match = "texto";
            result = relaxed;
            match = "texto";
          }
        }
      }

      if (result) {
        result.match = result.match || match;
        if (!result.items || result.items.length === 0) {
          result.hint =
            "0 resultados. Las etiquetas de cocina están en inglés (Italian, Tapas Bars, Mediterranean, Japanese...). " +
            "Prueba con q (texto libre), cambia la ciudad o pregunta al usuario; no inventes restaurantes.";
        }
      }
      return result;
    },
  },
  {
    name: "getRestaurant",
    description: "Obtiene el detalle completo de un restaurante por su id. Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: true,
    parameters: schema({
      id: str("Identificador del restaurante."),
    }, ["id"]),
    handler: async (ctx, args) => restaurantService.obtenerRestaurante(args.id),
  },
  {
    name: "countRestaurants",
    description: "Cuenta el total de restaurantes publicados en la plataforma. Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "checkAvailability",
    description: "Consulta los huecos libres de un restaurante en una fecha y hora. Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: true,
    parameters: schema({
      restauranteId: str("Identificador del restaurante."),
      fecha: FECHA(),
      hora: HORA(),
    }, ["restauranteId", "fecha", "hora"]),
    handler: async (ctx, args) =>
      reservationService.getDisponibilidad(args.restauranteId, args.fecha, args.hora),
  },
  {
    name: "listPromotions",
    description: "Lista las promociones activas de los restaurantes. Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: false,
    parameters: schema({
      restauranteId: str("Filtra promociones de un restaurante concreto."),
      estado: str("Estado de la promoción, p. ej. \"activa\"."),
    }),
  },
  {
    name: "listReviews",
    description: "Lista las reseñas de un restaurante ordenadas por likes. Rol: público.",
    roles: ROLES_PUBLICO,
    mutating: false,
    enabled: false,
    parameters: schema({
      restauranteId: str("Identificador del restaurante."),
    }, ["restauranteId"]),
  },

  // ── Tier cliente ──────────────────────────────────────────────────────────
  {
    name: "getUserReviews",
    description: "Lista las reseñas escritas por el usuario autenticado. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "createReservation",
    description: "Crea una reserva de mesa en un restaurante para una fecha y hora. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: true,
    parameters: schema({
      restauranteId: str("Identificador del restaurante."),
      fecha: FECHA(),
      hora: HORA(),
      comensales: num("Número de comensales (1-10).", { minimum: 1, maximum: 10 }),
      comentarios: str("Comentario opcional para el restaurante."),
    }, ["restauranteId", "fecha", "hora", "comensales"]),
    handler: async (ctx, args) =>
      reservationService.crearReserva({
        uid: ctx.user.uid,
        restauranteId: args.restauranteId,
        fecha: args.fecha,
        hora: args.hora,
        comensales: args.comensales,
        comentarios: args.comentarios || "",
        usuario: {
          email: ctx.user.email || "",
          nombre: ctx.user.nombre || ctx.user.displayName || "",
          displayName: ctx.user.displayName || ctx.user.nombre || "",
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    summarize: (args) => `${args.restauranteId} · ${args.fecha} ${args.hora} · ${args.comensales} pax`,
  },
  {
    name: "listMyReservations",
    description: "Lista las reservas propias del usuario, con filtro opcional por estado. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema({
      estado: str("Filtra por estado: pendiente, completada, cancelada o no_show."),
    }),
  },
  {
    name: "cancelReservation",
    description: "Cancela una reserva propia del usuario autenticado. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: true,
    parameters: schema({
      reservaId: str("Identificador de la reserva a cancelar."),
    }, ["reservaId"]),
    handler: async (ctx, args) =>
      reservationService.cancelarReserva(args.reservaId, ctx.user.uid, ctx.user.role === "admin"),
    summarize: (args) => `Reserva ${args.reservaId}`,
  },
  {
    name: "getBalance",
    description: "Consulta el saldo de puntos y las rachas del usuario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: true,
    parameters: schema(),
    handler: async (ctx, args) => pointsService.getBalance(ctx.user.uid),
  },
  {
    name: "getLedger",
    description: "Lista el histórico de movimientos de puntos del usuario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema({
      tipo: str("Filtra por tipo de movimiento, p. ej. \"reserva\", \"canje_descuento\"."),
      limit: num("Número de movimientos (1-100). Por defecto 20.", { minimum: 1, maximum: 100 }),
    }),
  },
  {
    name: "redeemPoints",
    description: "Canjea puntos del saldo por un descuento. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      puntos: num("Puntos a canjear, mayores que 0.", { minimum: 1 }),
    }, ["puntos"]),
  },
  {
    name: "dailyLogin",
    description: "Reclama los puntos del login diario y actualiza la racha. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "spinWheel",
    description: "Gira la ruleta del día 7 y reclama el premio obtenido. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "createReview",
    description: "Publica una reseña con puntuación y comentario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      restauranteId: str("Identificador del restaurante reseñado."),
      puntuacion: num("Puntuación de 1 a 5.", { minimum: 1, maximum: 5 }),
      comentario: str("Texto de la reseña."),
    }, ["restauranteId", "puntuacion", "comentario"]),
  },
  {
    name: "likeReview",
    description: "Añade un like a una reseña existente. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      resenaId: str("Identificador de la reseña."),
    }, ["resenaId"]),
  },
  {
    name: "unlikeReview",
    description: "Elimina tu like previo de una reseña. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      resenaId: str("Identificador de la reseña."),
    }, ["resenaId"]),
  },
  {
    name: "inviteMy",
    description: "Lista las invitaciones creadas y aceptadas por ti. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "createInvite",
    description: "Crea una invitación por email para invitar a un amigo. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      email: str("Email de la persona invitada."),
    }, ["email"]),
  },
  {
    name: "acceptInvite",
    description: "Acepta un código de invitación que has recibido. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      codigo: str("Código de invitación de 8 caracteres."),
    }, ["codigo"]),
  },
  {
    name: "listTickets",
    description: "Lista los tickets emitidos a tu nombre. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema({
      limit: num("Número de tickets (1-100). Por defecto 20.", { minimum: 1, maximum: 100 }),
    }),
  },
  {
    name: "getTicket",
    description: "Obtiene un ticket por su identificador. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema({
      ticketId: str("Identificador del ticket."),
    }, ["ticketId"]),
  },
  {
    name: "getMe",
    description: "Obtiene el perfil completo del usuario autenticado. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: true,
    parameters: schema(),
    handler: async (ctx, args) => usersService.getMe(ctx.user.uid),
  },
  {
    name: "updateMe",
    description: "Actualiza los datos de tu perfil de usuario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      tipo: str("Tipo de cuenta.", { enum: ["cliente", "empresa", "admin"] }),
      nombre: str("Nombre visible."),
      email: str("Email de contacto."),
      soloVegano: bool("Prefiere opciones veganas."),
      alergias: list("Lista de alergias o intolerancias.", str("Alergia o intolerancia.")),
      lang: str("Idioma preferido, p. ej. \"es\"."),
      favoritos: list("Lista de ids de restaurantes favoritos.", str("Id de restaurante.")),
    }),
  },
  {
    name: "listMensajes",
    description: "Lista los mensajes recibidos por el usuario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "unreadCount",
    description: "Cuenta los mensajes sin leer del usuario. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "markRead",
    description: "Marca un mensaje como leído. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      mensajeId: str("Identificador del mensaje."),
    }, ["mensajeId"]),
  },
  {
    name: "createContacto",
    description: "Envía un mensaje de contacto o incidencia al soporte. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      nombre: str("Tu nombre."),
      email: str("Tu email de contacto."),
      motivo: str("Motivo de la incidencia."),
      mensaje: str("Cuerpo del mensaje."),
    }, ["nombre", "email", "motivo", "mensaje"]),
  },
  {
    name: "listMine",
    description: "Lista tus incidencias de contacto enviadas al soporte. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "createNegocio",
    description: "Propone un nuevo local o negocio para darlo de alta. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      nombre: str("Nombre del local."),
      ciudad: str("Ciudad del local."),
      zona: str("Zona de búsqueda."),
      direccion: str("Dirección completa."),
      precio: str("Rango de precio.", { enum: ["€", "€€", "€€€"] }),
      categorias: list("Cocinas del local.", str("Categoría de cocina.")),
      telefono: str("Teléfono de contacto."),
      descripcion: str("Descripción del local."),
    }, ["nombre", "ciudad", "zona", "direccion", "precio", "categorias"]),
  },
  {
    name: "listMyNegocios",
    description: "Lista los negocios que tú has propuesto. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "trackInteraction",
    description: "Registra una vista o clic de promoción y suma puntos. Rol: cliente.",
    roles: ROLES_CLIENTE,
    mutating: true,
    enabled: false,
    parameters: schema({
      restauranteId: str("Identificador del restaurante promocionado."),
      tipo: str("Tipo de interacción.", { enum: ["view", "click"] }),
    }, ["restauranteId", "tipo"]),
  },

  // ── Tier empresa ──────────────────────────────────────────────────────────
  {
    name: "completeReservation",
    description: "Marca una reserva como completada y otorga sus puntos. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
      precioBase: num("Importe cobrado en euros (opcional).", { minimum: 0 }),
    }, ["reservaId"]),
  },
  {
    name: "reservationTicket",
    description: "Registra el ticket TPV de una reserva con su importe. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
      totalPagado: num("Importe total pagado en euros.", { minimum: 0 }),
      asistio: bool("Si el cliente asistió. Por defecto true."),
      fileName: str("Nombre del fichero del ticket."),
      tipoDocumento: str("Tipo de documento.", { enum: ["Ticket TPV", "Factura", "Otro"] }),
    }, ["reservaId", "totalPagado"]),
  },
  {
    name: "myRestaurants",
    description: "Lista los restaurantes que gestiona tu cuenta. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: false,
    enabled: false,
    parameters: schema({
      currentId: str("Id de un restaurante propio para priorizarlo."),
    }),
  },
  {
    name: "myRestaurant",
    description: "Obtiene un restaurante propio con sus métricas. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: false,
    enabled: false,
    parameters: schema({
      id: str("Id del restaurante propio (opcional si solo tienes uno)."),
    }),
  },
  {
    name: "updateRestaurant",
    description: "Actualiza los datos permitidos de un restaurante propio. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      restaurantId: str("Identificador del restaurante."),
      nombre: str("Nombre del restaurante."),
      direccion: str("Dirección."),
      telefono: str("Teléfono."),
      email: str("Email de contacto."),
      activo: bool("Si el restaurante está activo."),
      ciudad: str("Ciudad."),
      zona: str("Zona."),
      precio: str("Rango de precio.", { enum: ["€", "€€", "€€€"] }),
      cocina: str("Cocina principal."),
      descripcion: str("Descripción pública."),
      comisionPct: num("Comisión en porcentaje.", { minimum: 0, maximum: 100 }),
      maxReservasPorHora: num("Máximo de reservas por hora.", { minimum: 1, maximum: 100 }),
    }, ["restaurantId"]),
  },
  {
    name: "updateReservationStatus",
    description: "Cambia el estado de una reserva de tu restaurante. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
      status: str("Nuevo estado.", { enum: ["pendiente", "completada", "cancelada", "no_show"] }),
      precioBase: num("Importe cobrado en euros (opcional).", { minimum: 0 }),
    }, ["reservaId", "status"]),
  },
  {
    name: "confirmAttendance",
    description: "Confirma la asistencia del cliente a una reserva. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
      precioBase: num("Importe cobrado en euros (opcional).", { minimum: 0 }),
    }, ["reservaId"]),
  },
  {
    name: "markNoShow",
    description: "Marca una reserva como no presentado. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
    }, ["reservaId"]),
  },
  {
    name: "dashboardTicket",
    description: "Consulta el ticket asociado a una reserva. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: false,
    enabled: false,
    parameters: schema({
      reservaId: str("Identificador de la reserva."),
    }, ["reservaId"]),
  },
  {
    name: "createPromotion",
    description: "Crea una promoción de pago para un restaurante. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: true,
    enabled: false,
    parameters: schema({
      restauranteId: str("Identificador del restaurante."),
      tipo: str("Tipo de promoción. Por defecto boost_visibilidad."),
      fechaInicio: FECHA(),
      fechaFin: FECHA(),
      presupuestoTotal: num("Presupuesto total en euros.", { minimum: 0 }),
      cpc: num("Coste por clic en euros.", { minimum: 0 }),
      puntosExtraPorReserva: num("Puntos extra por reserva generada.", { minimum: 0 }),
    }, ["restauranteId", "fechaInicio", "fechaFin", "presupuestoTotal"]),
  },
  {
    name: "promoStats",
    description: "Muestra métricas de una promoción: vistas, clics y CTR. Rol: empresa.",
    roles: ROLES_EMPRESA,
    mutating: false,
    enabled: false,
    parameters: schema({
      promoId: str("Identificador de la promoción."),
    }, ["promoId"]),
  },

  // ── Tier admin ────────────────────────────────────────────────────────────
  {
    name: "listAllUsers",
    description: "Lista todos los usuarios registrados en la plataforma. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "adminOverview",
    description: "Resumen global de KPIs para administración. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "opsOverview",
    description: "Vista operativa de reservas, tickets e incidencias. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "adminReservations",
    description: "Busca reservas globales por texto o estado. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema({
      q: str("Texto libre: código, email, cliente, restaurante o fecha."),
      estado: str("Filtra por estado de la reserva."),
      limite: num("Máximo de reservas a devolver (1-500).", { minimum: 1, maximum: 500 }),
    }),
  },
  {
    name: "dashboardUsers",
    description: "Lista los usuarios desde el panel de administración. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "addManualPoints",
    description: "Suma o resta puntos a un usuario de forma manual. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      uid: str("Uid del usuario afectado."),
      cantidad: num("Puntos a añadir (negativos para restar).", { minimum: -100000, maximum: 100000 }),
      motivo: str("Motivo del ajuste (máx. 200 caracteres).", { maxLength: 200 }),
    }, ["uid", "cantidad"]),
  },
  {
    name: "setRacha",
    description: "Fija los días de racha de login de un usuario. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      uid: str("Uid del usuario."),
      dias: num("Días de racha a fijar (0-7).", { minimum: 0, maximum: 7 }),
    }, ["uid", "dias"]),
  },
  {
    name: "deltaRacha",
    description: "Incrementa o reduce la racha de login de un usuario. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      uid: str("Uid del usuario."),
      delta: num("Ajuste de días entre -7 y 7 (sin 0).", { minimum: -7, maximum: 7 }),
    }, ["uid", "delta"]),
  },
  {
    name: "unclaimToday",
    description: "Deshace el reclamo de login diario de hoy de un usuario. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      uid: str("Uid del usuario."),
    }, ["uid"]),
  },
  {
    name: "revenue",
    description: "Consulta los ingresos registrados en un rango de fechas. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema({
      from: FECHA(),
      to: FECHA(),
    }),
  },
  {
    name: "fraudFlags",
    description: "Lista las alertas de fraude detectadas. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "pendingNegocios",
    description: "Lista propuestas de negocio pendientes de revisión. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "approveNegocio",
    description: "Aprueba una propuesta y crea su restaurante. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      negocioId: str("Identificador de la propuesta de negocio."),
    }, ["negocioId"]),
  },
  {
    name: "rejectNegocio",
    description: "Rechaza una propuesta de negocio pendiente. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      negocioId: str("Identificador de la propuesta de negocio."),
    }, ["negocioId"]),
  },
  {
    name: "pendingContactos",
    description: "Lista las incidencias de contacto pendientes. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: false,
    enabled: false,
    parameters: schema(),
  },
  {
    name: "resolveContacto",
    description: "Marca una incidencia de contacto como resuelta. Rol: admin.",
    roles: ROLES_ADMIN,
    mutating: true,
    enabled: false,
    parameters: schema({
      contactoId: str("Identificador de la incidencia."),
    }, ["contactoId"]),
  },
];

// ── Handlers de fase 2 (src/modules/ai/handlers/*) ───────────────────────────
// Las 7 core de Fase 1 llevan handler inline. El resto se conecta por nombre
// desde los módulos de dominio, así que el registro sigue siendo la única fuente
// de verdad de parámetros/roles.
const extraHandlers = require("./handlers");

for (const tool of TOOLS) {
  if (typeof tool.handler !== "function" && typeof extraHandlers[tool.name] === "function") {
    tool.handler = extraHandlers[tool.name];
  }
}

// ── Flag de activación (AI_ENABLED_TOOLS) ───────────────────────────────────
// Las 7 core de Fase 1 están enabled:true. Las demás son enabled:false pero se
// pueden activar por entorno sin tocar código:
//   AI_ENABLED_TOOLS=all                     -> todas
//   AI_ENABLED_TOOLS=getLedger,spinWheel     -> solo esas (se suman a las core)
// Vacío (por defecto) -> solo las 7 core.
const CORE_ENABLED = new Set(TOOLS.filter((t) => t.enabled).map((t) => t.name));

function extraEnabled() {
  const raw = String(env.AI_ENABLED_TOOLS || "").trim();
  if (!raw || raw.toLowerCase() === "none") return new Set();
  if (raw.toLowerCase() === "all" || raw === "*") return new Set(TOOLS.map((t) => t.name));
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isEnabled(tool) {
  if (!tool) return false;
  if (CORE_ENABLED.has(tool.name)) return true;
  return extraEnabled().has(tool.name);
}

function getTool(name) {
  return TOOLS.find((t) => t.name === name);
}

function toolsForRole(role) {
  return TOOLS.filter((t) => {
    if (!isEnabled(t)) return false;
    if (t.roles.includes("public")) return true;
    if (!role) return t.roles.includes("cliente");
    return t.roles.includes(role);
  });
}

function checkAccess(tool, user) {
  if (!tool || tool.roles.includes("public")) return null;
  if (!user) {
    return { code: "MISSING_TOKEN", message: "Inicia sesión para usar esta función." };
  }
  if (!tool.roles.includes(user.role)) {
    return { code: "FORBIDDEN", message: "Tu rol no tiene permiso para esta operación." };
  }
  return null;
}

function toDeclaration(tool) {
  if (!tool) return undefined;
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

const KNOWN_CODES = new Set([
  "MISSING_TOKEN",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "INSUFFICIENT",
  "RATE_LIMITED",
  "WHEEL_LOCKED",
  "SELF_INVITE",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
]);

const DEFAULT_MESSAGES = {
  MISSING_TOKEN: "Inicia sesión para usar esta función.",
  FORBIDDEN: "Tu rol no tiene permiso para esta operación.",
  NOT_FOUND: "No se encontró el recurso solicitado.",
  CONFLICT: "La operación entra en conflicto con el estado actual.",
  VALIDATION_ERROR: "Los datos enviados no son válidos.",
  INSUFFICIENT: "Saldo insuficiente.",
  RATE_LIMITED: "Demasiadas peticiones. Inténtalo en unos segundos.",
  WHEEL_LOCKED: "La ruleta se abre con 7 días de racha; todavía no llegas.",
  SELF_INVITE: "No puedes invitarte a ti mismo.",
  NOT_IMPLEMENTED: "Esta función aún no está disponible.",
  INTERNAL_ERROR: "No se pudo completar la operación.",
};

function mapToolError(err) {
  const message = err && typeof err.message === "string" && err.message.trim() ? err.message : "";
  const code = err && typeof err.code === "string" ? err.code : null;

  if (code && KNOWN_CODES.has(code)) {
    if (code === "INTERNAL_ERROR") return { code, message: DEFAULT_MESSAGES.INTERNAL_ERROR };
    return { code, message: message || DEFAULT_MESSAGES[code] };
  }

  const text = message || "";
  let mapped = null;
  if (/no encontrado|no encontrada|ya no existe/i.test(text)) mapped = "NOT_FOUND";
  else if (/Completo|Máximo|ya tiene/i.test(text)) mapped = "CONFLICT";
  else if (/No autorizado|permiso/i.test(text)) mapped = "FORBIDDEN";
  else if (/no válida|inválid|Comensales/i.test(text)) mapped = "VALIDATION_ERROR";
  else if (/insuficiente/i.test(text)) mapped = "INSUFFICIENT";
  else if ((err && Number(err.status) === 429) || /rate/i.test(text)) mapped = "RATE_LIMITED";

  if (mapped) return { code: mapped, message: text || DEFAULT_MESSAGES[mapped] };
  return { code: "INTERNAL_ERROR", message: DEFAULT_MESSAGES.INTERNAL_ERROR };
}

module.exports = { TOOLS, getTool, toolsForRole, checkAccess, toDeclaration, mapToolError, isEnabled };
