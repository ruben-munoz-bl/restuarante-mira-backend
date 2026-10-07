/**
 * Catálogo de tipos de evento de auditoría. Debe coincidir con
 * src/components/ops/auditoriaCatalog.js del frontend (que añade etiqueta,
 * icono y color). Un tipo fuera del catálogo se rechaza: así un error de
 * escritura en el cliente no crea categorías fantasma en los gráficos.
 */
const CATEGORIAS = {
  auth: ["login_exitoso", "login_fallido", "login_google", "registro_iniciado", "registro_completado", "cierre_sesion",
    "recuperacion_password", "email_verificado", "sesion_iniciada", "sesion_cerrada"],
  navegacion: ["pagina_vista", "scroll_profundidad", "enlace_salida", "cta_pulsado", "ruta_cambiada"],
  busqueda: ["busqueda", "filtro_aplicado", "orden_cambiado", "paginacion", "mapa_marcador_pulsado"],
  catalogo: ["restaurante_visto", "restaurante_pulsado", "carta_abierta", "resena_vista", "resena_enviada",
    "favorito_añadido", "favorito_eliminado", "compartir", "interaccion"],
  reservas: ["reserva_iniciada", "reserva_creada", "reserva_confirmada", "reserva_cancelada", "reserva_completada",
    "reserva_no_show", "reserva_editada"],
  negocio: ["negocio_creado", "negocio_actualizado", "negocio_aprobado", "negocio_rechazado"],
  puntos: ["puntos_ganados", "puntos_canjeados", "rueda_girada", "invitación_enviada", "invitación_aceptada",
    "mira_abierta", "mira_mensaje", "mira_feedback", "promo_vista", "promo_pulsada"],
  admin: ["admin_login", "admin_acceso_denegado", "usuario_creado", "usuario_editado", "usuario_eliminado",
    "usuario_tipo_cambiado", "puntos_abonados", "puntos_ajustados", "racha_modificada", "login_revertido",
    "restaurante_editado", "restaurante_eliminado", "mensaje_enviado_dueno", "reserva_estado_cambiada",
    "confirmacion_asistencia", "marcado_no_show", "ticket_asignado", "incidencia_creada", "incidencia_resuelta",
    "franja_desbloqueada", "opcion_finanzas_activada", "ajustes_cambiados", "export_auditoria"],
};

const TIPOS = new Set(Object.values(CATEGORIAS).flat());
const CATEGORIA_DE = Object.fromEntries(Object.entries(CATEGORIAS).flatMap(([c, ts]) => ts.map((t) => [t, c])));

/** Tipos que cuentan como "cambio de configuración" en el resumen. */
const TIPOS_CONFIG = new Set(["ajustes_cambiados", "opcion_finanzas_activada", "franja_desbloqueada"]);

module.exports = { CATEGORIAS, TIPOS, CATEGORIA_DE, TIPOS_CONFIG };
