# Prompt para el equipo de frontend — Backend actualizado

Hola equipo. Hemos cambiado cosas en el backend que necesitan un ajuste en el frontend. Todos los cambios ya están **desplegados en producción**, así que se pueden ir incorporando.

El más importante: **la base de datos gratuita se nos agotó** y hemos tenido que optimizar. Os dejo lo que hay que cambiar y por qué.

---

## 0. TL;DR — qué hay que hacer hoy

| Prioridad | Cambio | Esfuerzo |
|---|---|---|
| 🔴 **P0** | El mapa pasa a `GET /v1/restaurants/mapa` | Cambiar 1 línea |
| 🟡 P1 | Debounce en el buscador (450 ms, mínimo 3 letras) | 10 min |
| 🟢 P2 | Revisar que nada sigue usando `?all=1` | 15 min |
| 🟢 P2 | (Opcional) Integrar descuentos | Siguiente sprint |

**Nada de esto rompe nada.** Los endpoints antiguos siguen funcionando; es cambiar para que no nos reventemos la base de datos.

---

## 0.bis. Cuánto cuesta cada endpoint (para decidir sin preguntar)

Medido con los 700 restaurantes reales:

| Endpoint | Tamaño | Lecturas a la BD | Veredicto |
|---|---|---|---|
| `GET /v1/restaurants?all=1` | **1,25 MB** | 0 (memoria) | 🔴 pesado, evítalo |
| `GET /v1/restaurants/mapa` | **198 KB** | 0 (memoria) | 🟢 **el que quieres** |
| `GET /v1/restaurants/mapa?ciudad=X` | ~60 KB | 0 | 🟢 ideal por zonas |
| `GET /v1/restaurants?q=...` | ~50 KB | 0 | 🟢 (ya sale de memoria) |
| `GET /v1/restaurants` (página) | ~40 KB | 0 | 🟢 |
| `GET /v1/restaurants/count` | 0 | 0 | 🟢 |
| `GET /v1/restaurants/:id` | ~2 KB | 0 | 🟢 |
| `GET /v1/points/balance` | ~1 KB | 1 | 🟢 normal |
| `GET /v1/reservations/availability` | ~0,2 KB | 1 | 🟢 |

**Regla fácil**: todo lo que empiece por `/v1/restaurants` ya no lee de la base de datos (está en memoria). Lo único que hay que vigilar es **el peso de la respuesta**: por eso el mapa usa `/mapa`.

---

## 1. ⚠️ CAMBIO PRINCIPAL: el mapa debe usar el endpoint nuevo

### Qué pasa

El mapa cargaba `/v1/restaurants?all=1`, que devuelve **1,25 MB** (toda la información de los 700 restaurantes, incluidas 3.500 reseñas que el mapa no usa).

### Qué hay que cambiar

```jsx
// ANTES (1,25 MB por carga)
const res = await fetch("/v1/restaurants?all=1");
const { items } = await res.json();

// AHORA (198 KB, 6 veces menos)
const res = await fetch("/v1/restaurants/mapa");
const { items, total } = await res.json();
```

Cada objeto de `items` tiene **solo estos 8 campos**:

| Campo | Ejemplo |
|---|---|
| `id` | `"PbdnBIKeTMpkUwZNoTLFeA"` |
| `nombre` | `"Ristorante Pizzeria Eden"` |
| `coordenadas` | `{ latitud: 41.397, longitud: 2.164 }` |
| `rating_yelp` | `4.7` (o `null`) |
| `precio` | `"€€"` (o `null`) |
| `categorias` | `["Pizza", "Italian"]` |
| `imagen_url` | `"https://…"` (o `null`) |
| `ciudad` | `"Barcelona"` |

**Ya no viene** `resenas`, `descripcion`, `telefono`, `horarios` ni `direccion`. Si el mapa o el popup los necesitas, se piden al abrir la ficha (`/v1/restaurants/:id`).

### Filtro por ciudad (opcional, recomendado)

```jsx
// En vez de los 700, solo los de una ciudad: ~60 KB
fetch("/v1/restaurants/mapa?ciudad=Barcelona")
```

La respuesta trae `Cache-Control: public, max-age=300`, así que el navegador la cachea 5 minutos solo.

### ⚠️ Si el mapa pinta los restaurantes de una zona

Revisad esto: el mapa pinta 695 restaurantes a la vez. Si lo hacéis por zonas, usad el filtro `?ciudad=` y **no descargéis los 700 para pintar 60**.

### Qué pasa si no lo cambiáis

Nada se rompe: `/all=1` sigue funcionando. Pero desperdicia 1,25 MB por carga y seguís consumiendo cuota de la BD, que es justo lo que agotó el plan.

---

## 2. Buscador: debounce (sigue siendo importante)

El backend ya cachea el catálogo en memoria, así que **una búsqueda ya no lee de la base de datos**. Aun así, no bombardeen el servidor:

```jsx
const MIN_CHARS = 3;      // no buscar con 1 letra
const DEBOUNCE_MS = 450;   // esperar a que dejes de escribir
```

Ya os lo detallamos en el informe anterior; sigue vigente.

---

## 3. Novedad: endpoint de descuentos

Lo necesitaba el frontend y no existía. Ya está:

**Ver los descuentos disponibles:**
```jsx
GET /v1/points/discounts
// { descuentos: [{ id: "5", puntos: 500, euros: 5, etiqueta: "5 € de descuento" }, ...] }
```

**Canjear puntos por un cupón:**
```jsx
POST /v1/points/discount/claim
{ "descuentoId": "10" }              // opcional: "restauranteId"
```
Respuesta `201`:
```json
{ "nuevoSaldo": 1000, "cupon": { "id": "...", "codigo": "MIRA-A3F9K2", "euros": 10, "estado": "activo", "expiraEn": "..." } }
```

Errores posibles:
| Código | Significado |
|---|---|
| `INSUFFICIENT` (400) | Saldo insuficiente, `message` lo explica |
| `VALIDATION_ERROR` (400) | Falta `descuentoId` |
| `NOT_FOUND` (404) | Usuario no encontrado |

**Si la UI que teníais esperaba otro formato**, decidme y lo adapto (nombre del campo, si el cupón se devuelve plano, etc.).

### 3.bis. Arreglado: `POST /v1/points/redeem` ya no da `VALIDATION_ERROR`

Nos habéis reportado un `VALIDATION_ERROR` al reclamar puntos. El culpable: **`/redeem` exigía `{puntos: número}` y el frontend mandaba `{descuentoId}`**.

Ya está arreglado. **Ahora `/redeem` entiende las dos cosas** (y de paso admite números como texto, que es lo que pasa con un `<input>`):

```jsx
// Las tres formas ahora valen (HTTP 201):
await redeem({ puntos: 500 });              // gastas 500 puntos
await redeem({ puntos: "500" });            // mismo, venía de un input
await redeem({ descuentoId: "5" });         // cupón de 5 € (500 puntos)
await redeem({ descuentoId: 10 });           // id como número
await redeem({ descuentoId: "5 €" });       // con símbolo
```

La respuesta indica qué pasó:
```json
{ "nuevoSaldo": 4500, "canjeadoComo": "puntos" }               // canje simple
{ "nuevoSaldo": 4500, "canjeadoComo": "descuento",
  "cupon": { "codigo": "MIRA-A3F9K2", "euros": 5 } }           // genera cupón
```

**Podéis dejar la UI como está**: funcione cual sea el formato que mandéis. Pero si queréis Simplificar, lo ideal sería que uséis siempre `/points/discount/claim` para descuentos (semántica clara) y `/redeem` solo para gastar puntos.

Si mandáis un body vacío o un descuento inexistente, seguirá dando `400`, pero ahora con un mensaje legible: *"Ese descuento no existe"*.

---

## 4. Cambio de comportamiento en el dashboard de restaurante

`GET /v1/dashboard/my-restaurant` ahora **devuelve `403`** si se le pasa `?restaurantId=` de un restaurante que **no es tuyo**. Antes eso se colaba y una empresa podía ver las finanzas de otra.

Si la UI usa `/restaurant/:id` para consultar un restaurante concreto que no es suyo, ya norespondemos `200`: tiene que gestionar ese `403`.

> El admin sí puede ver cualquiera (gestiona la plataforma).

### Requisito
El `Authorization` sigue siendo obligatorio en todo lo del dashboard (`Bearer <ID_TOKEN>`).

---

## 5. Cambios en la IA (por si lo integratoron)

### El "endpoint de chat" ahora es más rápido y no se rompe

`POST /v1/ai/agent` (sin cambios en la URL ni en el formato de entrada/salida), pero:

- Si llega un campo nuevo en la respuesta **`retryable: true`**, significa que la IA se quedó sin cuota ese instante. **Podéis reenviar la misma pregunta con 2-4 s de espera, hasta 2 veces**, sin mostrar error al usuario. El chat siempre devuelve `200` con un texto.
- La respuesta **ya nunca trae JSON crudo** ni texto cortado a media frase (lo arreglamos).

### Normalización de la fecha
La IA ahora sabe qué día es hoy. Si pides "reserva en junio" y junio ya pasó, te propondrá **junio del año que viene** o te preguntará. **Nunca** reserva en una fecha pasada.

---

## 6. Cómo verificar que todo va bien

**El mapa ya no consume casi nada.** Puedes comprobarlo:

```bash
curl https://<tu-api>/v1/restaurants/cache/stats
```
```json
{ "cache": { "cargas": 1, "aciertos": 250, "ttlMs": 300000, "tamano": 701 } }
```
- `cargas` = lecturas **reales** a Firestore desde que arrancó el servidor. Debería mantenerse en 1 o 2.
- Si `cargas` sube mucho, hay algún sitio que aún pide `all=1` o `/mapa` en bucle.

**Tamaño de la respuesta** (pestaña Network del navegador):
- `/v1/restaurants?all=1` → ~1,25 MB
- `/v1/restaurants/mapa` → ~198 KB ✅

---

## Resumen: qué hacer

| Prioridad | Tarea |
|---|---|
| 🔴 P0 | Cambiar el mapa a `GET /v1/restaurants/mapa` |
| 🟡 P1 | Debounce en el buscador (450 ms, mínimo 3 letras) |
| 🟢 P2 | Revisar que nada sigue llamando a `?all=1` |
| 🟢 P2 | Integrar el nuevo endpoint de descuentos (si lo queréis) |
| ⚪ Info | Gestionar el `403` del dashboard y el `retryable` de la IA |

Cualquier duda sobre el formato de los descuentos o el mapa, decidme y lo ajusto. Gracias! 🙌