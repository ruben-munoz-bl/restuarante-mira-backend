# API IA — Agente MIRA (para frontend)

Endpoint único de chat con IA que **responde y ejecuta acciones** sobre la API real (reservas, puntos, reseñas, promociones, panel de empresa y admin) respetando el rol del usuario.

```
POST /v1/ai/agent
Content-Type: application/json
```

## Headers

| Header | Obligatorio | Descripción |
|---|---|---|
| `Authorization: Bearer <ID_TOKEN>` | No (opcional) | Sin token el agente es anónimo: solo tools públicas. Las de usuario devuelven `MISSING_TOKEN` y el `reply` pide iniciar sesión. Token inválido **no da 401**: se trata como anónimo. |
| `Idempotency-Key: <uuid>` | No | Repite la respuesta cacheada si la misma clave vuelve a llegar. Clave distinta por cada paso de confirmación. |

Respuesta: cabecera `X-Prompt-Hash` (hash de la versión del prompt, para trazabilidad).

## Body (request)

```jsonc
{
  "message": "¿Qué tal Casa Lucio?",   // string, 1-2000, obligatorio
  "history": [                          // opcional, máx 10 entradas
    { "role": "user",  "content": "hola" },
    { "role": "model", "content": "¡Hola! ¿Buscas mesa?" }
  ],
  "confirmId": "uuid"                   // opcional: solo en el paso 2 de una confirmación
}
```

## Body (response)

```jsonc
{
  "reply": "Casa Lucio tiene 4.5 estrellas, cocina española en Madrid. ¿Te reservo mesa?",
  "actions": [
    { "tool": "searchRestaurants", "args": { "cocina": "Italian", "ciudad": "Barcelona" }, "result": { "ok": true, "data": { } } }
  ],
  "needsConfirm": {                      // SOLO si hay una acción mutante pendiente
    "confirmId": "550e8400-e29b-...",
    "summary": "r1 · 2030-01-01 13:00 · 4 pax",
    "payload": { "tool": "createReservation", "args": { } }
  },
  "provider": "gemini",
  "model": "gemini-3.5-flash-lite",
  "retryable": true
}
```

- `reply` — texto para mostrar tal cual (español, conciso, tono camarero).
- `actions` — trazabilidad de lo que la IA hizo o intentó:
  - `result.ok === true` → ejecutado (`result.data`).
  - `result.pending === true` → preparado, **sin ejecutar** (espera confirmación).
  - `result.ok === false` → error: `result.error` + `result.message`.
- `needsConfirm` — **clave del flujo de 2 pasos**. Si aparece, NADA se ha ejecutado todavía.
- `retryable` — solo aparece como `true` cuando el proveedor de IA falló (cuota o saturación). **El HTTP sigue siendo 200**: puedes reenviar el mismo `message` sin molestar al usuario.

## Flujo de confirmación (acciones mutantes)

Crear/cancelar/canjear/reescribir son mutantes: siempre 2 pasos.

```
1) POST { message: "Mesa para 4 el 2030-01-01 a las 13:00 en r1" }   (con Bearer)
   ← 200 { needsConfirm: { confirmId, summary, ... }, reply: "¿Confirmas la reserva...?" }

2) POST { message: "sí", confirmId: "<uuid>", history: [...] }        (con Bearer y MISMO token)
   ← 200 { actions:[{ tool:"createReservation", result:{ ok:true, data:{ id, codigo, ... } } }] }
```

- El `confirmId` es de **un solo uso**, **caduca a los 10 minutos** y está **ligado al usuario** que lo pidió.
- Si el usuario se arrepiente: no lo reenvíes y manda un mensaje nuevo.

## Catálogo de tools (60 activas)

Todas consultan la API real a través de los services. El agente solo ve las tools permitidas para el rol del token.

**Públicas (33 para anónimo y cliente):** `searchRestaurants`, `getRestaurant`, `countRestaurants`, `checkAvailability`, `listPromotions`, `listReviews`, `trackInteraction`.

**Cliente (+ autenticado):** `getMe`, `updateMe`, `getBalance`, `getLedger`, `redeemPoints`, `dailyLogin`, `spinWheel`, `createReservation`, `listMyReservations`, `cancelReservation`, `createReview`, `getUserReviews`, `likeReview`, `unlikeReview`, `inviteMy`, `createInvite`, `acceptInvite`, `listTickets`, `getTicket`, `listMensajes`, `unreadCount`, `markRead`, `createContacto`, `listMine`, `createNegocio`, `listMyNegocios`.

**Empresa y admin:** `completeReservation`, `reservationTicket`, `updateReservationStatus`, `confirmAttendance`, `markNoShow`, `myRestaurants`, `myRestaurant`, `updateRestaurant`, `createPromotion`, `promoStats`, `dashboardTicket`.

**Solo admin:** `listAllUsers`, `dashboardUsers`, `adminOverview`, `opsOverview`, `adminReservations`, `revenue`, `fraudFlags`, `addManualPoints`, `setRacha`, `deltaRacha`, `unclaimToday`, `pendingNegocios`, `approveNegocio`, `rejectNegocio`, `pendingContactos`, `resolveContacto`.

Totales por rol: anónimo/cliente **33**, empresa **44**, admin **60**. De las 60, **29 son mutantes** y pasan por confirmación.

## Errores HTTP

| Status | `error` | Qué hacer en la UI |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body inválido (message vacío/>2000, history>10, confirmId no-uuid). Corregir y reenviar. |
| 404 | `NOT_FOUND` | Ruta incorrecta (debe ser exactamente `/v1/ai/agent`). |
| 429 | `RATE_LIMITED` | **10 peticiones/min** por usuario o IP (`X-RateLimit-Limit/Remaining`). Reintentar tras el minuto. |
| 500 | `INTERNAL_ERROR` | Error inesperado (incluye `requestId`). Reintentar. |

Dentro de `actions[].result.error` (van en HTTP 200):

| `error` | Significado para el usuario |
|---|---|
| `MISSING_TOKEN` | "Inicia sesión" (el `reply` ya lo pide). |
| `FORBIDDEN` | Su rol no puede; no reintentar. |
| `WHEEL_LOCKED` | La ruleta pide racha de 7 días. |
| `INSUFFICIENT` | Saldo de puntos insuficiente. |
| `SELF_INVITE` | No puede invitarse a sí mismo. |
| `NOT_FOUND` / `CONFLICT` / `VALIDATION_ERROR` | `result.message` ya es texto amable para mostrar. |

## Notas para la UI

- Latencia real: **1-6 s** por turno. Timeout de red ≥ 25 s y spinner.
- **Reintento automático**: si llega `retryable: true`, reenvía el mismo `message` con un backoff de 2-4 s hasta 2 veces sin mostrar error al usuario (es saturación puntual de la IA).
- El proveedor en cascada es `gemini-3.5-flash-lite` (rápido) → `gemini-3.5-flash` (más capaz). `model` te dice cuál respondió.
- Muestra siempre `reply`; `actions` solo si quieres modo debug/consola.
- Mantén `history` en el cliente: reenvía las últimas 10 entradas para dar contexto.
- El agente nunca inventa: si no hay datos, lo dice. No parses `reply` para extraer datos: usa `actions[].result.data`.