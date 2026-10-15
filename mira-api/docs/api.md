# API MIRA — Referencia de endpoints

Documentación técnica de la API HTTP del backend `mira-api` (Node + Express + Firebase Admin/Firestore).

- **Base de las rutas de negocio:** `/v1`
- **Fichero de montaje:** `src/app.js`
- **Router por módulo:** `src/modules/<modulo>/routes.js` (el dashboard usa `src/modules/dashboard/router.js`)
- **Total de endpoints de negocio documentados:** 105
- **Health check (fuera de `/v1`):** `GET /health`

Documentación relacionada: [`base-de-datos.md`](base-de-datos.md) (colecciones, índices y
patrones de acceso), [`testing.md`](testing.md) (estrategia de tests) y
[`scripts.md`](scripts.md) (scripts de Firestore que se lanzan a mano).

Los ejemplos `curl` asumen:

```bash
BASE="http://localhost:3000"
TOKEN="<JWT ID token de Firebase>"
```

---

## 1. Convenciones globales

### 1.1 Cadena de middlewares (`src/app.js`)

En este orden, para todas las peticiones:

1. `helmet()` — cabeceras de seguridad.
2. `cors({ origin })` — si `CORS_ALLOWED_ORIGINS` está vacía (por defecto), política compatible: localhost:5173/4173 y cualquier `https://*.vercel.app`. Si tiene valor, solo esos orígenes exactos. Sin cabecera Origin (app móvil, curl) siempre se permite. Ver BUG-113 al final.
3. `express.json()` — cuerpo JSON.
4. `requestId` (`src/middlewares/errorHandler.js:24`) — usa la cabecera `x-request-id` del cliente o genera `req_<ts>_<rand>`, y responde siempre con la cabecera `X-Request-Id`.
5. `middlewareMetricas` (`src/modules/metricas/metricas.js:53`) — instrumentación en memoria. **Excluye** `/health`, `/v1/metricas/*` y cualquier ruta que acabe en `/stream`.
6. `requestLogger` (`src/middlewares/errorHandler.js:30`) — log `pino` al cerrar la respuesta.
7. `accessLog` (`src/middlewares/accessLog`).
8. Routers de módulo.
9. 404 global: `{ error: "NOT_FOUND", message: "Ruta no encontrada: <METHOD> <path>" }` (`src/app.js:72`).
10. `errorHandler` (`src/middlewares/errorHandler.js:8`).

Además se fija un `json replacer` global (`src/app.js:10`) que serializa como ISO-8601 los `Date`, los `Timestamp` de Firestore y los objetos con `_seconds`/`nanoseconds`.

### 1.2 Autenticación y roles (`src/middlewares/verifyFirebaseAuth.js`)

| Middleware | Comportamiento |
|---|---|
| `verifyFirebaseAuth` | Exige cabecera `Authorization: Bearer <idToken>`. Verifica con `admin.auth().verifyIdToken`. Deja `req.user = { uid, email, role }`. |
| `optionalAuth` | Si no hay cabecera, o el token falla, `req.user = null` y sigue. Nunca rechaza. |
| `authorize(...roles)` | Comprueba `req.user.role` contra la lista. |

El rol se resuelve en `resolveRole(uid)` leyendo `usuarios/{uid}.tipo`:

- Valor aceptado: `cliente` | `empresa` | `admin`.
- Documento inexistente, valor desconocido o error de Firestore → `cliente` (fallback silencioso, `src/middlewares/verifyFirebaseAuth.js:27`).

Errores:

| Situación | Estado | Cuerpo |
|---|---|---|
| Sin cabecera `Bearer` | `401` | `{"error":"MISSING_TOKEN","message":"Authorization header required"}` |
| Token inválido/expirado | `401` | `{"error":"INVALID_TOKEN","message":"Token inválido o expirado"}` |
| `authorize` sin `req.user` | `401` | `{"error":"UNAUTHORIZED"}` |
| Rol no autorizado | `403` | `{"error":"FORBIDDEN","message":"No tienes permiso"}` |

> Cuando `authorize` se invoca **solo** con `"admin"` y el rol no encaja, además registra en auditoría un evento `admin_acceso_denegado` con `ruta = (req.baseUrl + req.path).slice(0,200)`, `accion = req.method`, `resultado="error"` y `codigoError="FORBIDDEN"` (`src/middlewares/verifyFirebaseAuth.js:76`).

### 1.3 Validación (`src/middlewares/validate.js`)

`validate(schema, source = "body")` ejecuta `schema.safeParse()` de zod sobre `req.body`, `req.query` o `req.params` según `source`.

- Si falla: `400` con `{ "error": "VALIDATION_ERROR", "details": result.error.flatten().fieldErrors }`.
- Si pasa: **reemplaza** `req[source]` por los datos ya parseados (con *defaults* y *coerciones*) y guarda `req.validated = result.data`.

### 1.4 Rate limit (`src/middlewares/rateLimit.js`)

`rateLimit(windowMs = 60000, max = 100)`:

- Almacenamiento: `Map` **en memoria del proceso** (no compartido entre instancias).
- Clave: `` `${req.user?.uid || req.ip}:${req.baseUrl}${req.path}` `` — uid si hay sesión, si no IP.
- Ventana deslizante: guarda marcas de tiempo y filtra las mayores a `now - windowMs`.
- Cabeceras de respuesta: `X-RateLimit-Limit` y `X-RateLimit-Remaining`.
- Al superar el máximo: `429 {"error":"RATE_LIMITED","message":"Demasiadas peticiones, intenta más tarde"}`.
- Purgado cada 5 min (`SWEEP_MS`), ventana máxima guardada 5 min (`MAX_VENTANA_MS`) y recorte a `MAX_CLAVES = 20000` entradas.
- Existe `clearRateLimits()` para tests, exportado pero no usado en rutas.

`idempotency` (mismo fichero):

- Lee la cabecera `Idempotency-Key`. Si no está, no hace nada.
- Busca el SHA-256 de `[uid|anonymous, método, ruta sin query, key]` en `idempotencyKeys`.
- Si existe con status 2xx y coincide el hash del body validado/canónico, re-sirve la respuesta; si el body difiere, responde `409 IDEMPOTENCY_CONFLICT`.
- Si existe con status no-2xx, lo borra y continúa (nunca se cachea un error).
- Si no existe, envuelve `res.json` para persistir `{status, body, requestHash, createdAt}` en cuanto la respuesta sea 2xx. Antes de guardar pasa el body por `firestoreSafe()` (elimina `undefined`, `NaN`, `Infinity`).
- Cualquier fallo de Firestore en la cacheación se ignora: la respuesta al cliente sale igualmente.

### 1.5 Manejo de errores (`src/middlewares/errorHandler.js`)

`errorHandler` produce:

```json
{ "error": "<err.code o INTERNAL_ERROR>", "message": "<mensaje>", "requestId": "<x-request-id o 'unknown'>" }
```

- Estado: `err.status || 500`.
- En `NODE_ENV=production`, si el estado es ≥ 500, `message` se sustituye por `"Error interno"`.
- `requestId` se lee de la **cabecera** `x-request-id`, no de `req.id` (puede diferir de la cabecera `X-Request-Id` emitida).

Existe también `asyncHandler(fn)`, que envuelve handlers y encamina los rechazos a `next(err)`.

### 1.6 Formato de errores por endpoint

Cuando un handler captura la excepción y la mapea a mano, la forma **no** lleva `requestId` (se responde desde el handler, no desde `errorHandler`). Ejemplos reales:

```json
{ "error": "NOT_FOUND" }
{ "error": "CONFLICT", "message": "Completo a esa hora. Prueba otra franja." }
```

---

## 2. Auth y configuración de credenciales

`src/middlewares/verifyFirebaseAuth.js` inicializa `firebase-admin` al cargarse:

1. Busca credencial en `process.env.GOOGLE_APPLICATION_CREDENTIALS` (resuelto a ruta absoluta).
2. Si no, prueba `src/../serviceAccountKey.json`.
3. Si ninguna existe, **no es fatal**: inicializa solo con `projectId` y escribe un `console.warn`; las peticiones a Firestore fallarán hasta que se monte la clave.

Config (`src/config/env.js`, validada con zod; el proceso hace `exit(1)` si falla):

| Variable | Default | Uso relevante en la API |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `PROJECT_ID` | `restaurante-mira-18e0c` | Firebase |
| `NODE_ENV` | `development` | `production` oculta mensajes 5xx y restringe `AI_PROVIDER` |
| `GEMINI_API_KEY` | — | **Obligatoria** en producción (refine de zod) |
| `AI_PROVIDER` | `gemini` | Proveedor del agente |
| `AI_MODEL` / `AI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` / `gemini-3.5-flash` | Modelos |
| `AI_ENABLED_TOOLS` | `all` | Flags de herramientas del agente (`""` = solo las 7 core) |
| `PUNTOS_RESERVA_BASE` | `100` | Puntos por reserva completada |
| `MULTIPLICADOR_RACHA` | `1.2` | Multiplicador con racha de reservas |
| `PUNTOS_LOGIN_BASE` / `_INCREMENTO` / `_CAP` / `_GRACE_MAX` | `5` / `3` / `15` / `2` | Racha de login |
| `PUNTOS_INVITACION` | `200` | Puntos por invitación completada |
| `INVITACIONES_MAX_MES` | `5` | Límite de invitaciones |
| `INVITACIONES_RESERVAS_REQUERIDAS` | `2` | Reservas que debe completar el invitado |
| `PUNTOS_REVIEW` | `20` | Puntos por reseña |
| `PUNTOS_PROMO_VIEW` / `_CLICK` | `2` / `5` | Puntos por interaccion con promo |
| `COMISION_PCT` | `8` | Comisión por defecto (fallback si el restaurante no define `comisionPct`) |
| `CATALOG_CACHE_TTL_MS` | `900000` | TTL de la caché del catálogo en memoria |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `100` | Defaults; **las rutas pasan valores literales**, no leen estas vars |
| `AUDITORIA_MAX_DIA` | `8000` | Cuota diaria de escritura de auditoría |
| `AUDITORIA_IP_SALT` / `LOGS_IP_SALT` | `mira-auditoria` | Sal del hash de IP |

---

## 3. Salud

### `GET /health`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /health` |
| Fichero | `src/app.js:48` |
| Auth | Ninguna |
| Roles | — |
| Parámetros | — |
| Body | — |
| Respuesta | `200 {"status":"ok","timestamp":"<ISO-8601>"}` |
| Errores | — |

```bash
curl "$BASE/health"
```

```json
{ "status": "ok", "timestamp": "2026-10-09T08:14:22.301Z" }
```

---

## 4. Catálogo de restaurantes — `/v1/restaurants`

Router: `src/modules/restaurants/routes.js`. Servicio: `src/modules/restaurants/service.js`.

### 4.1 `GET /v1/restaurants`

Lista paginada con filtros. `TAMANO_PAGINA = 27`; `limit` se recorta al rango `[1, 100]` (`Math.min(Math.max(…,1),100)`).

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants` |
| Auth | `optionalAuth` |
| Roles | — (cualquiera, anche anónimo) |
| Query | `limit` (int, def. 27), `all` (`"1"`/`"true"`), `cursor` (base64 de `{rating, id}`), `ratingYelp`, `ciudad`, `zona`, `cocina`, `q` |
| Body | — |
| Respuesta | `200 { items: Restaurante[], cursor: string\|null, terminado: boolean }` |
| Errores | 500 `INTERNAL_ERROR` si falla Firestore |

Comportamiento (`service.js:243`):

- Con `all=1` o `limit=0`: lee el **catálogo cacheado en memoria**, ordena por `rating_yelp` descendente (desempate por `id` ascendente), aplica filtros y devuelve `cursor: null`, `terminado: true`.
- Con `q` no vacío y sin `all`: filtra **en memoria** sobre el catálogo (`0` lecturas de Firestore) y pagina con cursor.
- Sin `q` y sin `all`: consulta Firestore con `orderBy("rating_yelp","desc")` + `orderBy("__name__","desc")`, aplicando `where` por `ciudad`, `zona_busqueda` y `categorias array-contains`.
- Si Firestore devuelve error de índice (`failed-precondition` / mensaje con "index"), hace fallback a paginar el catálogo en memoria con la misma semántica.
- `ratingYelp` se acepta en el query pero **no se usa** en `listarRestaurantes` (`no determinable con el código actual` su efecto).
- Filtro por texto (`filtrarPorTexto`): normaliza a minúsculas y sin tildes (`NFD`) y busca en `nombre`, `categorias`, `ciudad`, `zona_busqueda`, `direccion_completa || direccion`.
- El documento `__catalogo__` se excluye de los resultados.

```bash
curl "$BASE/v1/restaurants?ciudad=Barcelona&cocina=Vegetariano&limit=10"
```

```bash
curl "$BASE/v1/restaurants?q=veggie&ciudad=Madrid"
```

```json
{
  "items": [ { "id": "r_abc", "nombre": "Green Bowl", "ciudad": "Barcelona", "rating_yelp": 4.7, "categorias": ["Vegetariano"] } ],
  "cursor": "eyJyYXRpbmciOjQuNywiaWQiOiJyX2FiYyJ9",
  "terminado": false
}
```

### 4.2 `GET /v1/restaurants/count`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants/count` |
| Fichero | `routes.js:29` |
| Auth | `optionalAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { total: number, count: number }` (ambos con el mismo valor) |
| Errores | 500 `INTERNAL_ERROR` |

`contarRestaurantes()` devuelve `catalogo().length`: el total sale de la **caché en memoria**, `0` lecturas de Firestore (`service.js:337`).

```bash
curl "$BASE/v1/restaurants/count"
```

```json
{ "total": 698, "count": 698 }
```

### 4.3 `GET /v1/restaurants/mapa`

Versión ligera para el mapa: 8 campos por restaurante.

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants/mapa` |
| Fichero | `routes.js:40` |
| Auth | `optionalAuth` |
| Roles | — |
| Query | `ciudad` (filtro exacto en memoria) |
| Body | — |
| Cabecera de respuesta | `Cache-Control: public, max-age=300` |
| Respuesta | `200 { items: MapaRestaurante[], total: number }` |
| Errores | 500 `INTERNAL_ERROR` |

Estrategia de lectura (`service.js:174`):

1. Si el catálogo está en memoria → 0 lecturas.
2. Si no, intenta el documento ligero `__catalogo__` → 1 lectura + 1 `count()`, **solo si sigue reflejando la colección** (`catalogoDesactualizado`: `doc.total` frente al recuento real).
3. Si no existe, está desactualizado o está marcado como sucio, construye desde los restaurantes sueltos y **regenera el documento una única vez**.

`listarMapa` **no** regenera el documento en cada llamada: la regeneración la hace `catalogo()` cuando detecta que hace falta (alta/baja fuera de este proceso, o edición de un restaurante).

```bash
curl "$BASE/v1/restaurants/mapa?ciudad=Valencia"
```

```json
{ "items": [ { "id": "r_x", "nombre": "Casa B", "ciudad": "Valencia", "precio": "€€", "lat": 39.47, "lng": -0.37, "rating_yelp": 4.2 } ], "total": 1 }
```

### 4.4 `GET /v1/restaurants/:id/foto`

Redirección a la foto de Google Places.

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants/:id/foto` |
| Fichero | `routes.js:52` |
| Auth | **Ninguna** (ruta sin middleware) |
| Roles | — |
| Path | `id` — id del restaurante |
| Body | — |
| Respuesta | `302` redirect a la URL temporal de Google |
| Cabeceras | `X-Foto-Autor` (autor de la foto, URL-encoded) si lo hay; `Cache-Control: public, max-age=1800` |
| Errores | `404 {"error":"NOT_FOUND","message":"Sin foto de Google"}`; 500 `INTERNAL_ERROR` |

```bash
curl -i "$BASE/v1/restaurants/r_abc/foto"
```

### 4.5 `GET /v1/restaurants/cache/stats`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants/cache/stats` |
| Fichero | `routes.js:65` |
| Auth | `optionalAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { cache: {...} }` |
| Errores | — |

`estadisticasCache()` (`service.js:199`) devuelve:

| Campo | Significado |
|---|---|
| `cargas` | Cargas completas del catálogo |
| `aciertos` | Servidos desde caché caliente |
| `misses` | Cargas reales a Firestore |
| `desfasados` | Servidos con datos viejos mientras se refresca |
| `ttlMs` | `CATALOG_CACHE_TTL_MS` (default 900000) |
| `cargadoEnMsAgo` | `null` si no hay caché |
| `tamano` | Número de restaurantes cacheados |

```bash
curl "$BASE/v1/restaurants/cache/stats"
```

```json
{ "cache": { "cargas": 3, "aciertos": 812, "misses": 4, "desfasados": 2, "ttlMs": 900000, "cargadoEnMsAgo": 41200, "tamano": 698 } }
```

### 4.6 `GET /v1/restaurants/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/restaurants/:id` |
| Fichero | `routes.js:69` |
| Auth | `optionalAuth` |
| Roles | — |
| Path | `id` |
| Body | — |
| Respuesta | `200 Restaurante` — objeto `{ id, ...camposDelDocumento }` |
| Errores | `404 {"error":"NOT_FOUND"}` cuando el mensaje contiene "no encontrado"; 500 `INTERNAL_ERROR` |

`obtenerRestaurante(id)`: si la caché está hidratada desde `_catalogo` de forma **parcial**, lee el documento real para devolver el detalle completo (con reseñas y campos pesados); si está completa, sirve desde memoria.

```bash
curl "$BASE/v1/restaurants/r_abc"
```

### 4.7 `PUT /v1/restaurants/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/restaurants/:id` |
| Fichero | `routes.js:95` |
| Auth | `verifyFirebaseAuth` |
| Roles | **Ninguno exigido** — cualquier usuario autenticado |
| Path | `id` |
| Body | `updateSchema` (zod), todos opcionales |
| Respuesta | `200 { updated: boolean }` |
| Errores | `400 VALIDATION_ERROR` con `details`; `404 {"error":"NOT_FOUND"}`; 500 `INTERNAL_ERROR` |

Esquema del body (`routes.js:79`):

| Campo | Tipo |
|---|---|
| `nombre`, `direccion`, `telefono`, `ciudad`, `zona`, `precio`, `cocina`, `descripcion` | `string` |
| `email` | `string` con formato email |
| `horarios` | `any` |
| `activo` | `boolean` |
| `comisionPct`, `maxReservasPorHora` | `number` |

`actualizarRestaurante` (`service.js:384`) filtra por la **misma lista `allowed`** (13 campos), añade `updatedAt`, escribe, y llama `invalidarCatalogoPorEscritura()` (`service.js:457`): marca el flag `sucio` e invalida la caché, así que el siguiente `/mapa` hace full scan y **regenera `_catalogo`** (no hace falta TTL). Si el body tras el filtro queda vacío devuelve `{ updated: false }` sin escribir.

> No hay comprobación de propiedad del restaurante en esta ruta: el control de pertenencia real vive en `GET /v1/dashboard/my-restaurant` (`getMyRestaurant`). Con el código actual, `PUT /v1/restaurants/:id` **no verifica que el usuario sea dueño**.

```bash
curl -X PUT "$BASE/v1/restaurants/r_abc" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"precio":"€€","maxReservasPorHora":8,"activo":true}'
```

```json
{ "updated": true }
```

---

## 5. Reservas — `/v1/reservations`

Router: `src/modules/reservations/routes.js`. Servicio: `src/modules/reservations/service.js`.

**Franjas horarias válidas** (`SLOTS` en `src/config/constants.js:3`):

```
12:00 12:30 13:00 13:30 14:00 14:30 20:00 20:30 21:00 21:30 22:00
```

**Aforo por franja:** documento `aforo/{restaurantId}_{fecha}_{hora}` con `{ ocupadas, limite, retenidas }`.

**Límite por local** (`limiteDelLocal`, `service.js:17`): usa `restaurante.maxReservasPorHora` si es entero > 0; si no, lo deriva del nº de reseñas de Yelp (`limitePorResenas`): `<100 → 4`, `<500 → 6`, `<1000 → 8`, `<2000 → 10`, resto `12`.

### 5.1 `GET /v1/reservations/availability`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/reservations/availability` |
| Fichero | `routes.js:22` |
| Auth | `optionalAuth` |
| Roles | — |
| Query | `restauranteId` (o alias `restaurantId`), `fecha`, `hora` |
| Body | — |
| Respuesta | `200 { limite, ocupadas, libres, retenidaParaTi, retenidaHasta }` |
| Errores | `404 {"error":"NOT_FOUND"}`; 500 `INTERNAL_ERROR` |

Comportamiento (`service.js:38`):

- La ficha del restaurante sale de la **caché de catálogo** (0 lecturas).
- Si falta `fecha` o `hora`: devuelve `{ limite, ocupadas: 0, libres: limite }` (sin `libresPara`).
- Con franja: lee `aforo/{rest}_{fecha}_{hora}` y añade `espera().libresPara(aforo, limite, uid)`, que descuenta del total las **retenciones vigentes de otros** y marca si la plaza está retenida para el propio usuario:

```json
{ "limite": 8, "ocupadas": 6, "libres": 2, "retenidaParaTi": false, "retenidaHasta": null }
```

```bash
curl "$BASE/v1/reservations/availability?restauranteId=r_abc&fecha=2026-10-15&hora=21:00"
```

### 5.2 `POST /v1/reservations`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/reservations` |
| Fichero | `routes.js:38` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Middlewares extra | `validate(crearReservaSchema)`, **`idempotency`** |
| Body | `crearReservaSchema` (zod) |
| Respuesta | `201 { id, codigo, restauranteNombre, fecha, hora, comensales }` |
| Errores | `400 VALIDATION_ERROR` (+`details`), `409 CONFLICT`, `500 INTERNAL_ERROR` |

Esquema del body (`routes.js:10`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `fecha` | `string` con regex `^\d{4}-\d{2}-\d{2}$` | Sí |
| `hora` | `string` (debe estar en `SLOTS`) | Sí |
| `comensales` | entero `1..10` o string numérico equivalente; no booleanos, arrays, decimales ni sufijos | Sí |
| `restauranteId` | `string` min 1 | Uno de los dos |
| `restaurantId` | `string` min 1 | (alias) |
| `comentarios` | `string` máx 500 | No |
| `nombreRestaurante` | `string` | No |
| `usuarioNombre` | `string` | No |
| `usuarioEmail` | `string` | No |

> `restauranteId` y `restaurantId` son ambos opcionales en el esquema; el servicio resuelve `restaurantId || restauranteId` (`service.js:51`). Si ambos faltan, `tx.get` de un id vacío lanza y acaba en 500.

El handler sobrescribe `usuario` con `{ email: req.user.email, displayName: req.user.email }` (los campos del body no mandan en el actor).

`crearReserva` (`service.js:51`) en una transacción:

1. Valida `hora ∈ SLOTS` (`"Hora no válida"`) y `comensales` entero `1..10` (`"Comensales: 1-10"`).
2. Lee el restaurante; si no existe → 404 `NOT_FOUND`.
3. Lee el aforo; si `ocupadas + retenciones ajenas >= limite` → error con `code: "COMPLETO"`.
4. Crea la reserva con `estado: "pendiente"`, `codigo = MIRA-<base36 ts>`, `puntosGenerados: 0`, `multiplicadorAplicado: 1`, y campos derivados del restaurante (`ciudad`, `zona`, `terraza`, `nombreRestaurante`).
5. Si el usuario tenía plaza retenida, la consume y marca la espera como confirmada.
6. Incrementa `aforo.ocupadas`.

Mapeo de errores del handler:

| Mensaje del servicio | Estado | Cuerpo |
|---|---|---|
| Contiene `"Completo"` o `"Máximo"` | `409` | `{"error":"CONFLICT","message":…}` |
| Contiene `"no válida"` o `"Comensales"` | `400` | `{"error":"VALIDATION_ERROR","message":…}` |

```bash
curl -X POST "$BASE/v1/reservations" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: resv-2026-10-15-2100-001" \
  -d '{"restauranteId":"r_abc","fecha":"2026-10-15","hora":"21:00","comensales":4,"comentarios":"Mesa junto a la ventana"}'
```

```json
{
  "id": "Xk2AbC",
  "codigo": "MIRA-LQ7ZK1",
  "restauranteNombre": "Green Bowl",
  "fecha": "2026-10-15",
  "hora": "21:00",
  "comensales": 4
}
```

Reenviar la misma petición con la misma `Idempotency-Key` devuelve el mismo `201` con el cuerpo cacheado, sin crear una segunda reserva.

### 5.3 `GET /v1/reservations`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/reservations` |
| Fichero | `routes.js:58` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Query | `estado` (filtro exacto) |
| Body | — |
| Respuesta | `200 { data: Reserva[] }` |
| Errores | 500 `INTERNAL_ERROR` |

`listarReservas` (`service.js:206`): `where("uid","==",uid).orderBy("fecha","desc")` con `limit(100)`. Si el índice compuesto no está desplegado (error `failed-precondition`), hace fallback sin `orderBy`: lee hasta 200, filtra por estado y ordena en memoria, devolviendo los primeros 100.

```bash
curl "$BASE/v1/reservations?estado=pendiente" -H "Authorization: Bearer $TOKEN"
```

### 5.4 `PUT /v1/reservations/:id/cancel`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/reservations/:id/cancel` |
| Fichero | `routes.js:67` |
| Auth | `verifyFirebaseAuth` |
| Roles | Dueño de la reserva **o** `admin` (comprobado en servicio con `req.user.role === "admin"`) |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok":true,"estado":"cancelada"}` |
| Errores | `403 {"error":"FORBIDDEN"}`, `404 {"error":"NOT_FOUND"}`, `409 {"error":"CONFLICT",…}`, 500 `INTERNAL_ERROR` |

`cancelarReserva` (`service.js:114`) en transacción:

- Si no existe → `"La reserva ya no existe."` → **404**
- Si `estado === "cancelada"` → `"Ya estaba cancelada."` → **409**
- Si no es admin y `reserva.uid !== uid` → `"No autorizado"` → **403**
- Marca `cancelada`, **decrementa** `aforo.ocupadas` (con `Math.max(0, …)`), y después llama `espera().alLiberarseMesa(...)`: avisa al primero de la cola y le retiene la plaza 30 minutos.

```bash
curl -X PUT "$BASE/v1/reservations/Xk2AbC/cancel" -H "Authorization: Bearer $TOKEN"
```

### 5.5 `PUT /v1/reservations/:id/complete`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/reservations/:id/complete` |
| Fichero | `routes.js:79` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` (`authorize("empresa","admin")`) |
| Path | `id` |
| Body | `{ precioBase?: number }` — **sin zod**; se lee `req.body.precioBase` |
| Respuesta | `200 { yaCompletada?: true }` si ya estaba completada, o `{ completada: true, ticket, puntos, multiplicador }` |
| Errores | 500 `INTERNAL_ERROR` (no hay mapeo específico; "Reserva no encontrada" acaba como 500 con `err.status` undefined) |

`completarReserva` (`service.js:171`):

1. Si no existe → `Error("Reserva no encontrada")` (sin `status`) → 500.
2. Si ya estaba `completada` → `{ yaCompletada: true }` (idempotente, sin puntos ni ticket).
3. Marca `completada`.
4. `otorgarPuntosReserva`: `puntos = round(PUNTOS_RESERVA_BASE × multiplicador)`, con `multiplicador = MULTIPLICADOR_RACHA (1.2)` si el usuario tiene `rachaReservasSemanas >= 1`, si no `1`. Registra movimiento en `puntos_movimientos` (`tipo: "reserva"`) y guarda `puntosGenerados` / `multiplicadorAplicado` en la reserva.
5. Genera el ticket con `emitidoPor: "restaurante-simulado"` y `precioManual` (fallo de ticket **no** rompe la respuesta).
6. Llama `onInvitadoReservaCompletada(reserva.uid)` (idéntico, best-effort).

```bash
curl -X PUT "$BASE/v1/reservations/Xk2AbC/complete" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"precioBase":48.50}'
```

```json
{ "completada": true, "ticket": { "id": "t_1", "precioTotal": 48.5 }, "puntos": 120, "multiplicador": 1.2 }
```

### 5.6 `POST /v1/reservations/:id/ticket`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/reservations/:id/ticket` |
| Fichero | `routes.js:92` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | **Sin zod** (líneas 94-100) |
| Respuesta | `201 { ticketId, comision, neto, estado }` |
| Errores | `409 CONFLICT`, `404 NOT_FOUND`, `400 VALIDATION_ERROR`, 500 `INTERNAL_ERROR` |

Body leído por el handler:

| Campo | Tipo | Default |
|---|---|---|
| `totalPagado` | number o string (`"45,50"` se acepta) con `> 0` | — |
| `asistio` | boolean | `true` (se usa `!== false`) |
| `fileName` | string | `""` |
| `tipoDocumento` | string | `"Ticket TPV"` |

`subirTicket` (`service.js:223`). Los errores de negocio llevan `status`/`code`, así que
devuelven su HTTP real (404/409/400) en vez de caer en el 500 genérico del `errorHandler`:

1. Reserva inexistente → `404 NOT_FOUND` "Reserva no encontrada".
2. Si `reserva.ticketId` existe **o** ya hay un documento en `tickets` con ese `reservaId` → `409 CONFLICT` "Esta reserva ya tiene un ticket registrado (máx. 1 por reserva)".
3. Si la reserva no tiene `restaurantId` ni `restauranteId` → `400 VALIDATION_ERROR` "Reserva sin restaurante vinculado".
4. `totalPagado <= 0`, vacío o no numérico → `400 VALIDATION_ERROR` "Importe inválido".
5. Calcula `comision = round(total × comisionPct / 100, 2)` y `neto = round(total − comision, 2)`. El `comisionPct` es el del restaurante o, si no, `env.COMISION_PCT` (8).
6. En transacción: crea el `ticket`, actualiza la reserva (`estado`, `totalPagado`, `importeComision`, `netoRestaurante`, `ticketId`, `asistio`) y acumula en `finanzas_restaurante/{restaurantId}` (`ingresosBrutos`, `comisiones`, `neto`, `totalTickets`, `comensalesAtendidos`, `baseImponible = total/1.1`). **La lectura de `finanzas_restaurante` va antes de cualquier `tx.set`/`tx.update`**: Firestore rechaza lecturas tras escrituras ("read after write") y eso hacía fallar siempre este endpoint con 500.
7. Si `asistio`: otorga puntos de reserva y dispara el check de invitaciones (ambos best-effort).
8. Devuelve `{ ticketId, comision, neto, estado }` con el **id real** del ticket creado.

```bash
curl -X POST "$BASE/v1/reservations/Xk2AbC/ticket" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"totalPagado":48.50,"asistio":true,"fileName":"ticket-15oct.pdf","tipoDocumento":"Factura simplificada"}'
```

```json
{ "ticketId": "Xk2AbCdefGhijKLMnopQr", "comision": 3.88, "neto": 44.62, "estado": "completada" }
```

---

## 6. Puntos MIRA — `/v1/points`

Router: `src/modules/points/routes.js`. Servicios: `src/modules/points/service.js` y `src/modules/points/dailyLogin.js`.

**Racha de login** (`calcRachaLogin`, `service.js:18`), sobre día local `Europe/Madrid`:

- Máximo 7 días.
- Si `ultimoLoginDate === hoy` → `yaReclamado: true`, `puntos: 0`.
- `diff === 1` → `dias + 1`.
- `diff === 2` y `graceUsados < 2` → `graceUsados + 1` (día de gracia, sin cambio de días).
- Resto: si `diff > 2` → `dias = 1` y `graceUsados = 0`; si `diff <= 1` → `dias + 1`.
- Puntos: `min(5 + 3 × max(0, dias − 1), 15)`, y **0** si `dias >= 7` (día 7 es la ruleta).

**Ruleta** (`WHEEL_PRIZES`, `service.js:5`): 20 (peso 475), 25 (200), 30 (150), 50 (120), 100 (5).

**Catálogo de descuentos** (`DESCUENTOS_DISPONIBLES`, `service.js:210`): `"5"` → 500 pts / 5 €; `"10"` → 1000 pts / 10 €; `"20"` → 2000 pts / 20 €. `buscarDescuento` acepta id, número o texto con `€`/`eur`.

### 6.1 `GET /v1/points/balance`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/points/balance` |
| Fichero | `routes.js:12` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 Balance` |
| Errores | 500 `INTERNAL_ERROR` |

`Balance` (`service.js:49`):

| Campo | Significado |
|---|---|
| `saldoActual` | `saldoPuntos` del documento |
| `totalAcumulado` | `totalAcumulado` |
| `totalCanjeado` | `totalCanjeado` |
| `rachaLogin.dias` | **Racha almacenada** en Firestore (clamp 0-7), no la proyección |
| `rachaLogin.ultimoLogin` | `ultimoLoginDate` o `null` |
| `rachaLogin.graceUsados` | Días de gracia ya consumidos |
| `rachaLogin.yaReclamado` | Proyección: ¿se reclamó hoy? |
| `rachaLogin.puntosHoy` | Puntos que daría el reclamo de hoy (`0` si ya se reclamó o es día 7) |
| `rachaLogin.dia7Disponible` | ¿Toca día 7 (ruleta)? |
| `rachaLogin.diasTrasReclamo` | Proyección de días si se reclamara ahora |
| `rachaReservas.semanasConsecutivas` | `rachaReservasSemanas` |
| `rachaReservas.multiplicador` | `rachaReservasMultiplicador` (default 1) |

```bash
curl "$BASE/v1/points/balance" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "saldoActual": 640,
  "totalAcumulado": 1820,
  "totalCanjeado": 1180,
  "rachaLogin": { "dias": 3, "ultimoLogin": "2026-10-09", "graceUsados": 0, "yaReclamado": false, "puntosHoy": 11, "dia7Disponible": false, "diasTrasReclamo": 3 },
  "rachaReservas": { "semanasConsecutivas": 2, "multiplicador": 1.2 }
}
```

### 6.2 `GET /v1/points/is-new-user`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/points/is-new-user` |
| Fichero | `routes.js:21` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 {"isNew": boolean}` |
| Errores | 500 `INTERNAL_ERROR` |

`isNewUser` (`service.js:76`): `true` si `!ultimoLoginDate && (rachaLoginDias || 0) === 0`.

```bash
curl "$BASE/v1/points/is-new-user" -H "Authorization: Bearer $TOKEN"
```

```json
{ "isNew": false }
```

### 6.3 `GET /v1/points/ledger`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/points/ledger` |
| Fichero | `routes.js:30` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Query | `tipo` (filtro), `limit` (int, def. 20) |
| Body | — |
| Respuesta | `200 { data: MovimientoPuntos[] }` |
| Errores | 500 `INTERNAL_ERROR` |

`getLedger` (`service.js:82`): `puntos_movimientos` filtrado por `uid`, ordenado por `createdAt` descendente. Sin paginación por cursor.

```bash
curl "$BASE/v1/points/ledger?tipo=canje_descuento&limit=5" -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": [ { "id": "m_1", "uid": "u_1", "tipo": "canje_descuento", "puntos": -500, "descripcion": "Canje: 5 € de descuento", "createdAt": "2026-10-08T10:00:00.000Z" } ] }
```

### 6.4 `POST /v1/points/redeem`

Doble semántica: gasto de puntos o canje de un descuento del catálogo.

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/points/redeem` |
| Fichero | `routes.js:56` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(redeemSchema)` |
| Roles | — |
| Body | `redeemSchema` (zod, con `refine`) |
| Respuesta | `201` |
| Errores | `400 VALIDATION_ERROR` (+`details`), `400 INSUFFICIENT`, 500 `INTERNAL_ERROR` |

Esquema (`routes.js:46`):

| Campo | Tipo | Notas |
|---|---|---|
| `puntos` | `coerce.number().int().positive()` | Opción A |
| `descuentoId` | número > 0, entero > 0, o `string` min 1 | Opción B; acepta `"5"`, `5`, `"5 €"` |
| `restauranteId` | `string` min 1 o `null` | Opcional |

`refine`: debe venir `puntos` **o** `descuentoId`, con mensaje `"Indica 'puntos' (número) o 'descuentoId' (5, 10 o 20)"`.

Comportamiento (`routes.js:58`):

- Si viene `descuentoId` (y `puntos` es `undefined`): llama `canjearDescuento(uid, descuentoId, restauranteId)` y responde `201 { …resultado, canjeadoComo: "descuento" }` → incluye `nuevoSaldo` y `cupon`.
- Si viene `puntos`: `redeem(uid, puntos)` → `201 { nuevoSaldo, canjeadoComo: "puntos" }`.

Mapeo de errores: `err.code === "INSUFFICIENT"` o mensaje con "insuficiente" → `400 INSUFFICIENT`; `err.code === "VALIDATION_ERROR"` → `400 VALIDATION_ERROR`.

```bash
# Gastar puntos
curl -X POST "$BASE/v1/points/redeem" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"puntos":300}'

# Canjear el descuento de 5 € (acepta id o euros)
curl -X POST "$BASE/v1/points/redeem" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"descuentoId":"5","restauranteId":"r_abc"}'
```

```json
{ "nuevoSaldo": 340, "canjeadoComo": "puntos" }
```

```json
{
  "nuevoSaldo": 140,
  "cupon": { "id": "c_1", "uid": "u_1", "descuentoId": "5", "euros": 5, "puntos": 500, "restauranteId": "r_abc", "codigo": "MIRA-7KQP2D", "estado": "activo", "usado": false, "expiraEn": "2026-11-08T…Z" },
  "canjeadoComo": "descuento"
}
```

### 6.5 `POST /v1/points/daily-login`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/points/daily-login` |
| Fichero | `routes.js:79` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Body | — |
| Respuesta | `200` si ya se reclamó hoy; `201` si se acaba de reclamar |
| Errores | 500 `INTERNAL_ERROR` (p. ej. usuario inexistente → `"Usuario no encontrado"`) |

Respuesta según el estado (`dailyLogin.js:5`):

| Caso | Estado | Cuerpo |
|---|---|---|
| Reclamo nuevo con puntos | `201` | `{ yaReclamado:false, puntos, racha, nuevoSaldo }` |
| Ya reclamado hoy | `200` | `{ yaReclamado:true, puntos:0, racha }` |
| Día 7 disponible | `201` | `{ yaReclamado:false, puntos:0, racha, dia7Disponible:true, nuevoSaldo }` (no suma puntos: toca la ruleta) |

```bash
curl -X POST "$BASE/v1/points/daily-login" -H "Authorization: Bearer $TOKEN"
```

```json
{ "yaReclamado": false, "puntos": 11, "racha": { "dias": 3, "ultimoLogin": "2026-10-09", "graceUsados": 0, "yaReclamado": false, "puntos": 11, "dia7Disponible": false }, "nuevoSaldo": 651 }
```

### 6.6 `GET /v1/points/wheel/prizes`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/points/wheel/prizes` |
| Fichero | `routes.js:88` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { prizes: { puntos, label }[] }` |
| Errores | — |

Handler síncrono: solo devuelve la lista estática, **no** consulta nada.

```bash
curl "$BASE/v1/points/wheel/prizes" -H "Authorization: Bearer $TOKEN"
```

```json
{ "prizes": [ { "puntos": 20, "label": "20 MIRA" }, { "puntos": 25, "label": "25 MIRA" }, { "puntos": 30, "label": "30 MIRA" }, { "puntos": 50, "label": "50 MIRA" }, { "puntos": 100, "label": "100 MIRA" } ] }
```

### 6.7 `POST /v1/points/wheel`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/points/wheel` |
| Fichero | `routes.js:92` |
| Auth | `verifyFirebaseAuth` |
| Roles | — (el query `force=1` solo funciona con rol `admin` **y** fuera de producción) |
| Query | `force` (`"1"`) |
| Body | — |
| Respuesta | `201 { puntos, label, nuevoSaldo }` |
| Errores | `403 WHEEL_LOCKED`, o el `status`/`code` queoonsulta fija el error; 500 `INTERNAL_ERROR` |

`claimWheelReward` (`service.js:159`):

- Gira la ruleta por peso y, en transacción, exige día 7 (`proy.dia7Disponible || rachaLoginDias >= 7 || proy.dias >= 7`).
- Si no es día 7 y no hay `force`: error `status: 403`, `code: "WHEEL_LOCKED"`, mensaje `` `Ruleta no disponible: racha ${dias}/7` ``.
- Al conceder: suma el premio a `saldoPuntos` y `totalAcumulado`, **pone `rachaLoginDias: 0`** y `ultimoLoginDate: hoy`, `graceUsados: 0`, y registra el movimiento con `tipo: "ruleta_dia7"`.
- `force` solo se activa si `env.NODE_ENV !== "production"` **y** `req.query.force === "1"` **y** `req.user.role === "admin"`.

El handler reenvía `err.status` y `err.code` tal cual si existen.

```bash
curl -X POST "$BASE/v1/points/wheel" -H "Authorization: Bearer $TOKEN"
```

```json
{ "puntos": 30, "label": "30 MIRA", "nuevoSaldo": 681 }
```

### 6.8 `GET /v1/points/discounts`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/points/discounts` |
| Fichero | `routes.js:109` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { descuentos: [...] }` |
| Errores | — |

Catálogo estático con `disponibles: true` añadido a cada entrada (`service.js:216`). Los cupones ya canjeados viven en la colección `descuentos`; este endpoint **no** los consulta.

```bash
curl "$BASE/v1/points/discounts" -H "Authorization: Bearer $TOKEN"
```

```json
{ "descuentos": [ { "id": "5", "puntos": 500, "euros": 5, "etiqueta": "5 € de descuento", "disponibles": true }, { "id": "10", "puntos": 1000, "euros": 10, "etiqueta": "10 € de descuento", "disponibles": true }, { "id": "20", "puntos": 2000, "euros": 20, "etiqueta": "20 € de descuento", "disponibles": true } ] }
```

### 6.9 `POST /v1/points/discount/claim`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/points/discount/claim` |
| Fichero | `routes.js:113` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(discountClaimSchema)` |
| Roles | — |
| Body | `{ descuentoId: string min 1, restauranteId?: string min 1 \| null }` |
| Respuesta | `201 { nuevoSaldo, cupon }` |
| Errores | `400 INSUFFICIENT`, `400 VALIDATION_ERROR`, `404 NOT_FOUND`, 500 `INTERNAL_ERROR` |

Misma transacción que el camino `descuentoId` de `/redeem` (`canjearDescuento`, `service.js:241`):

- Descuento inexistente → `status 400`, `code VALIDATION_ERROR`, `"Ese descuento no existe"` → handler responde `400 VALIDATION_ERROR`.
- Usuario inexistente → `code NOT_FOUND`, `status 404` → handler `404 NOT_FOUND`.
- Saldo insuficiente → `code INSUFFICIENT`, mensaje `` `Saldo insuficiente: necesitas ${puntos} puntos y tienes ${saldo}` ``.

Genera un cupón de un solo uso: `codigo = MIRA-<6 chars>`, `estado: "activo"`, `usado: false`, `expiraEn = createdAt + 30 días`.

```bash
curl -X POST "$BASE/v1/points/discount/claim" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"descuentoId":"10","restauranteId":"r_abc"}'
```

```json
{ "nuevoSaldo": 140, "cupon": { "id": "c_2", "descuentoId": "10", "euros": 10, "puntos": 1000, "codigo": "MIRA-B4T9ZC", "estado": "activo", "usado": false } }
```

### 6.10 `POST /v1/points/review`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/points/review` |
| Fichero | `points/routes.js` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Body | `{ reviewId }` (obligatorio) |
| Respuesta | `201 { puntos: 20, nuevoSaldo }` si se abonan; `200 { puntos: 0, nuevoSaldo, yaOtorgados: true }` si ya se dieron |
| Errores | 400 `VALIDATION_ERROR` (sin `reviewId`); 404 `NOT_FOUND` (reseña inexistente); 403 `FORBIDDEN` (reseña de otro usuario) |

`reviewPoints(uid, reviewId)` (`points/service.js`) abona **20 puntos solo por una reseña real del propio usuario y una única vez por usuario y restaurante**. Todo va en una transacción: lee la reseña, comprueba que `usuarioId` es el del token y usa un movimiento con id fijo `resena_{uid}_{restauranteId}` en `puntos_movimientos`. Si ya existe, no suma nada. Así no se pueden obtener puntos sin reseña, ni reintentando, ni escribiendo varias reseñas del mismo restaurante.

`POST /v1/reviews` y la tool de IA `createReview` llaman a esta función tras crear la reseña (best-effort). Este endpoint queda solo como reintento manual; la web y la app no lo usan.

**Antes (corregido en BUG-111):** el endpoint no tenía body y abonaba 20 puntos a cualquiera que lo llamara, sin reseña.

### 7.1 `GET /v1/users/me`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/users/me` |
| Fichero | `routes.js:9` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200` perfil, o fallback `{ uid, tipo, email }` |
| Errores | 500 `INTERNAL_ERROR` |

`getMe(uid)` (`service.js:6`) devuelve `null` si no existe el documento; el handler responde entonces con `{ uid, tipo: req.user.role, email: req.user.email || "" }`.

Cuando existe, los campos son: `uid`, `tipo` (normalizado a `cliente` si no es `empresa`/`admin`), `nombre`, `email`, `soloVegano`, `alergias`, `lang`, `consentimientoCookies`, `preferencias`, `accesibilidad`, `favoritos`, `restaurantId`, `restaurantIds`, `saldoPuntos`, `createdAt`, `actualizado`.

```bash
curl "$BASE/v1/users/me" -H "Authorization: Bearer $TOKEN"
```

```json
{ "uid": "u_1", "tipo": "cliente", "nombre": "Ana", "email": "ana@example.com", "soloVegano": false, "alergias": ["gluten"], "lang": "es", "favoritos": ["r_abc"], "restaurantId": null, "restaurantIds": [], "saldoPuntos": 640 }
```

### 7.2 `PUT /v1/users/me`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/users/me` |
| Fichero | `routes.js:32` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(updateSchema)` |
| Roles | — |
| Body | `updateSchema` (zod) |
| Respuesta | `200 { updated: boolean }` |
| Errores | `400 VALIDATION_ERROR` (+`details`); 500 `INTERNAL_ERROR` |

Esquema (`routes.js:18`):

| Campo | Tipo |
|---|---|
| `tipo` | `enum("cliente","empresa")` — **`admin` está excluido deliberadamente** |
| `nombre`, `email`, `lang` | `string` |
| `soloVegano` | `boolean` |
| `alergias`, `favoritos` | `string[]` |
| `consentimientoCookies`, `preferencias`, `accesibilidad` | `any` |

`updateMe` (`service.js:30`) filtra por `PERFIL_KEYS` (las 10 claves del esquema), añade `actualizado` y hace `set(..., { merge: true })`. Reglas:

- Si llega `tipo: "admin"`, se descarta.
- Si el usuario **ya** era `admin`, se descarta cualquier `tipo` (un admin no se rebaja desde su perfil).
- Si el body tras el filtro no tiene nada, devuelve `{ updated: false }`.

```bash
curl -X PUT "$BASE/v1/users/me" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nombre":"Ana Ruiz","soloVegano":true,"alergias":["gluten","frutos secos"],"lang":"es"}'
```

```json
{ "updated": true }
```

### 7.3 `GET /v1/users/me/is-admin`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/users/me/is-admin` |
| Fichero | `routes.js:41` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 {"isAdmin": boolean}` |
| Errores | — (el service atrapa errores y devuelve `false`) |

`esAdmin(uid)` (`service.js:48`) lee `usuarios/{uid}.tipo === "admin"`; cualquier excepción devuelve `false`.

```bash
curl "$BASE/v1/users/me/is-admin" -H "Authorization: Bearer $TOKEN"
```

```json
{ "isAdmin": false }
```

### 7.4 `GET /v1/users/all`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/users/all` |
| Fichero | `routes.js:50` |
| Auth | `verifyFirebaseAuth` + `authorize("admin")` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 UsuarioResumen[]` (**array pelado**, sin envoltorio `data`) |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getAllUsers()` (`service.js:58`) lee la colección `usuarios` **completa sin paginar** y añade la proyección de racha (`calcRachaLogin`). Campos: `uid`, `nombre`, `email`, `tipo`, `saldoPuntos`, `rachaLoginDias` (clamp 0-7), `ultimoLoginDate`, `yaReclamadoHoy`, `createdAt`.

```bash
curl "$BASE/v1/users/all" -H "Authorization: Bearer $TOKEN"
```

```json
[ { "uid": "u_1", "nombre": "Ana", "email": "ana@example.com", "tipo": "cliente", "saldoPuntos": 640, "rachaLoginDias": 3, "ultimoLoginDate": "2026-10-09", "yaReclamadoHoy": false } ]
```

---

## 8. Panel de restaurante y panel de administración — `/v1/dashboard`

Router: `src/modules/dashboard/router.js` (19 endpoints). Servicio: `src/modules/dashboard/service.js`.

### 8.1 `GET /v1/dashboard/my-restaurants`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/my-restaurants` |
| Fichero | `router.js:27` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Query | `currentId` (fuerza un id al frente de la lista) |
| Body | — |
| Respuesta | `200 { id, nombre, ciudad }[]` (**array pelado**) |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`listMyRestaurants(uid, email, currentId)` (`service.js:105`) agrega ids desde varias fuentes, en `Promise.all`:

- `usuarios/{uid}.restaurantId` y `usuarios/{uid}.restaurantIds[]`
- `restaurants` donde `uid == uid`
- `restaurants` donde `email == req.user.email`
- Propuestas en `negocios` con `estado === "aprobada"` (y su `restaurantId`); para las aprobadas sin `restaurantId`, busca en `restaurants` por `nombre` y puntúa coincidencia por `uid`, luego por `email`.

Si `currentId` no está en la lista, lo antepone con nombre `"Restaurante activo"` como fallback.

```bash
curl "$BASE/v1/dashboard/my-restaurants?currentId=r_abc" -H "Authorization: Bearer $TOKEN"
```

```json
[ { "id": "r_abc", "nombre": "Green Bowl", "ciudad": "Barcelona" } ]
```

### 8.2 `GET /v1/dashboard/my-restaurant`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/my-restaurant` |
| Fichero | `router.js:32` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Query | `id` o `restaurantId` (override del restaurante) |
| Body | — |
| Respuesta | `200 { restaurante, finanzas, stats, proximasReservas, reservasHoy, reservasParaTicket, ingresosPorMes, ticketsRecientes }` |
| Errores | `403 FORBIDDEN`, `404 NOT_FOUND`, 500 `INTERNAL_ERROR` |

Resolución del restaurante (`resolverRestaurante`, `service.js:214`), en orden: override explícito → `restaurants/{id}` con `restaurantId` declarado → primer `restaurantIds[]` → `restaurants.uid`. Si ningún candidato apunta a un documento que **existe**, se responde `404 NOT_FOUND` con mensaje que termina en "ya no existe" (distingue "tu restaurante fue borrado" de "nunca tuviste uno", cuyo mensaje anima a pasar `?restaurantId=`). Devuelve `{ id, doc }` para no releer el documento. El helper antiguo `resolveRestaurantId` se eliminó (era un wrapper muerto).

Errores con `status`/`code` reales (no 500): `404` si no hay restaurante resolto; `403 FORBIDDEN` solo cuando se pasa override y el rol no es `admin`.

Control de pertenencia (`service.js:239`): **solo cuando se pasa override** y el rol no es `admin`. Comprueba que el id esté en `restaurantIds`/`restaurantId` del usuario, o que `restaurante.uid === uid`, o que `restaurante.email === usuario.email`. En caso contrario `403 FORBIDDEN`. Sin override, no hay comprobación (se resolvió desde los datos del propio usuario).

`buildRestaurantAggregates` (`service.js:38`) devuelve `stats` con: `totalReservas`, `reservasCompletadas`, `reservasCanceladas`, `reservasNoShow`, `reservasPendientes`, `reservasHoy`, `totalFacturacion`, `totalComisiones`, `ticketPromedio`, `totalTicketsFin`, `comensalesFin`, `reservasNoCanceladas`. Estados reconocidos: pendientes = `pendiente|confirmada|activa|en_mesa|en mesa`; completada = `completada|pagado|pagada`; no-show = `no_show|no-show|no show`.

Además: `proximasReservas` (20, pendientes, desde hoy), `reservasHoy` (orden por hora), `reservasParaTicket` (50, no canceladas sin `ticketId`), `ingresosPorMes` (`{ "YYYY-MM": { facturacion, comisiones, tickets } }`), `ticketsRecientes` (20).

```bash
curl "$BASE/v1/dashboard/my-restaurant?restaurantId=r_abc" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "restaurante": { "id": "r_abc", "nombre": "Green Bowl", "ciudad": "Barcelona" },
  "finanzas": { "ingresosBrutos": 12400, "comisiones": 992, "neto": 11408, "totalTickets": 254 },
  "stats": { "totalReservas": 310, "reservasCompletadas": 240, "reservasCanceladas": 30, "reservasNoShow": 12, "reservasPendientes": 28, "reservasHoy": 22, "totalFacturacion": 12400, "totalComisiones": 992, "ticketPromedio": 48.82, "totalTicketsFin": 254, "comensalesFin": 820, "reservasNoCanceladas": 280 },
  "proximasReservas": [], "reservasHoy": [], "reservasParaTicket": [], "ingresosPorMes": { "2026-09": { "facturacion": 5100, "comisiones": 408, "tickets": 104 } }, "ticketsRecientes": []
}
```

### 8.3 `GET /v1/dashboard/restaurant/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/restaurant/:id` |
| Fichero | `router.js:37` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | — |
| Respuesta | Idéntica a `my-restaurant` |
| Errores | `403 FORBIDDEN`, `404 NOT_FOUND`, 500 `INTERNAL_ERROR` |

Es `getMyRestaurant(req.user.uid, req.params.id, req.user.role)`: al ser override, **sí** aplica el control de pertenencia descrito en 8.2 (salvo para `admin`).

```bash
curl "$BASE/v1/dashboard/restaurant/r_abc" -H "Authorization: Bearer $TOKEN"
```

### 8.4 `GET /v1/dashboard/admin`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/admin` |
| Fichero | `router.js:42` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { stats, reservasPorRestaurante, facturacionPorMes, ticketsRecientes }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getAdminDashboard()` (`service.js:273`) cachea **90 s** en memoria (`DASHBOARD_CACHE_MS`, default 90000) y deduplica peticiones concurrentes con `inflight`.

`calcularAdminDashboard` (`service.js:298`): los totales salen de `count()` (usuarios, no-admin, reservas, promociones, promociones activas) y los desgloses de ventanas de 500 documentos recientes. `stats`: `totalUsuarios`, `usuariosActivos`, `totalReservas`, `reservasCompletadas`, `reservasCanceladas`, `reservasNoShow`, `totalFacturacion`, `totalComisiones`, `totalPromociones`, `promosActivas`. `ticketsRecientes` trae 30.

```bash
curl "$BASE/v1/dashboard/admin" -H "Authorization: Bearer $TOKEN"
```

```json
{ "stats": { "totalUsuarios": 15432, "usuariosActivos": 15200, "totalReservas": 88120, "reservasCompletadas": 5100, "reservasCanceladas": 900, "reservasNoShow": 210, "totalFacturacion": 248900, "totalComisiones": 19912, "totalPromociones": 420, "promosActivas": 68 }, "reservasPorRestaurante": {}, "facturacionPorMes": {}, "ticketsRecientes": [] }
```

### 8.5 `GET /v1/dashboard/ops/overview`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/ops/overview` |
| Fichero | `router.js:47` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { avisos, kpis, serie, porEstado, ocupacion, incidenciasPreview, pendientesTotal, negociosTotal, top, feed }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getOpsOverview()` (`service.js:407`) usa `Promise.allSettled` sobre 6 fuentes (reservas 500, tickets 200, count de restaurantes, count de usuarios, contactos pendientes, negocios pendientes) y acumula en `avisos` el nombre de las que fallaron, de modo que **una fuente caída degrada el panel sin romperlo**.

`kpis`: `reservasTotal`, `asistenciaPct`, `restaurantesActivos`, `incidenciasPendientes`, `criticas`, `usuariosTotal`, `comisionTotal`, `facturacionTotal`, `ticketPromedio`, `mediaComensal`, `ticketsTotal`, `comisionPct`, `precioMedioPax`, `altas7d`, `negociosPendientes`. `ocupacion` separa `comida` / `cena` (reservas y pax).

```bash
curl "$BASE/v1/dashboard/ops/overview" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "avisos": [],
  "kpis": { "reservasTotal": 500, "asistenciaPct": 82.3, "restaurantesActivos": 698, "incidenciasPendientes": 14, "usuariosTotal": 15432, "comisionTotal": 5120.4, "facturacionTotal": 64005, "ticketPromedio": 51.2, "mediaComensal": 24.4, "ticketsTotal": 1250, "comisionPct": 8, "precioMedioPax": 18, "altas7d": 132, "negociosPendientes": 6 },
  "porEstado": { "confirmada": 0, "pendiente": 90, "completada": 320, "cancelada": 60, "no_show": 30 },
  "ocupacion": { "comida": { "reservas": 210, "pax": 640 }, "cena": { "reservas": 290, "pax": 880 } }
}
```

### 8.6 `GET /v1/dashboard/reservations`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/reservations` |
| Fichero | `router.js:52` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Query | `q`, `estado`, `limite` (int, def. 100) |
| Body | — |
| Respuesta | `200 Reserva[]` (**array pelado**) |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getReservasGlobales` (`service.js:615`) lee las **500 reservas más recientes** y filtra en memoria: `q` busca (en minúsculas) en `codigo`, `usuarioEmail`, `email`, `usuarioNombre`, nombre del restaurante y `fecha`; `estado` compara con `reserva.estado || "pendiente"`. Devuelve los primeros `limite`.

```bash
curl "$BASE/v1/dashboard/reservations?q=MIRA&estado=pendiente&limite=25" -H "Authorization: Bearer $TOKEN"
```

### 8.7 `PUT /v1/dashboard/restaurant/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/dashboard/restaurant/:id` |
| Fichero | `router.js:61` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | **Sin zod**; se filtran 13 campos conocidos |
| Respuesta | `200 { updated: boolean }` |
| Errores | 403 `FORBIDDEN`; 404 `NOT_FOUND`; 500 `INTERNAL_ERROR` |

`updateRestaurant` (`service.js:632`) acepta los mismos 13 campos que `PUT /v1/restaurants/:id`, añade `updatedAt`, y lanza `404 NOT_FOUND` si el documento no existe. Después de escribir llama a `invalidarCatalogoPorEscritura()` (`service.js:674`), así que el catálogo cacheado **sí se refresca** en la siguiente lectura (no hay que esperar al TTL): `sucio = true` fuerza full scan y regeneración de `_catalogo`.

```bash
curl -X PUT "$BASE/v1/dashboard/restaurant/r_abc" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"comisionPct":10,"activo":false}'
```

### 8.8 `GET /v1/dashboard/restaurants`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/restaurants` |
| Fichero | `router.js:66` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Query | `limit`, `all`, `cursor`, `q`, `ciudad`, `cocina` |
| Body | — |
| Respuesta | `200 { items, cursor, terminado }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Delega en `restaurantService.listarRestaurantes` con los mismos filtros que `GET /v1/restaurants`, **menos** `ratingYelp` y `zona`.

```bash
curl "$BASE/v1/dashboard/restaurants?ciudad=Barcelona&limit=25" -H "Authorization: Bearer $TOKEN"
```

### 8.9 `DELETE /v1/dashboard/restaurant/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `DELETE /v1/dashboard/restaurant/:id` |
| Fichero | `router.js:78` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Path | `id` |
| Body | — |
| Respuesta | `200 { deleted: true, id }` |
| Errores | 403 `FORBIDDEN`; 404 `NOT_FOUND`; 500 `INTERNAL_ERROR` |

`eliminarRestaurante` (`service.js:653`) comprueba existencia (404), borra el documento y llama `invalidarCatalogoPorEscritura()`.

```bash
curl -X DELETE "$BASE/v1/dashboard/restaurant/r_xyz" -H "Authorization: Bearer $TOKEN"
```

```json
{ "deleted": true, "id": "r_xyz" }
```

### 8.10 `POST /v1/dashboard/restaurant/:id/message`

Mensaje del admin al buzón del dueño del restaurante.

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/restaurant/:id/message` |
| Fichero | `router.js:83` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(z.object({...}))` |
| Roles | `admin` |
| Path | `id` |
| Body | `{ mensaje: string 1..4000 (obligatorio), asunto?: string máx 160 }` |
| Respuesta | `201 { ok: true, id, uidDueno, aviso }` |
| Errores | `400 VALIDATION_ERROR` (+`details`); `403 FORBIDDEN`; `404 NOT_FOUND`; 500 `INTERNAL_ERROR` |

`enviarMensajeDueno` (`service.js:668`):

- Sin restaurante → 404.
- Si el restaurante no tiene `ownerUid` **ni** `email` → `400 VALIDATION_ERROR` con `"Este restaurante no tiene dueño asociado (sin uid ni email)"`.
- Con `uidDueno`: documento en `mensajes` con `uid: uidDueno`, `tipo: "admin"`, `de: adminUid`, `titulo = asunto || "Mensaje del equipo MIRA — <nombre>"`, `leido: false`, `fecha`/`hora` en `Europe/Madrid`.
- Sin uid: se guarda con `uid: null` y `emailDueno` (mensaje pendiente de entrega) y el `aviso` lo indica.

```bash
curl -X POST "$BASE/v1/dashboard/restaurant/r_abc/message" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"asunto":"Documentación pendiente","mensaje":"Necesitamos la licencia para publicar la carta."}'
```

```json
{ "ok": true, "id": "msg_1", "uidDueno": "u_owner", "aviso": "Mensaje enviado al buzón del dueño." }
```

### 8.11 `PUT /v1/dashboard/reservations/:id/status`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/dashboard/reservations/:id/status` |
| Fichero | `router.js:95` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | **Sin zod**: `{ status, precioBase? }` |
| Respuesta | `200 { updated: true, status }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Delega en `reservations/service.actualizarEstado` (`service.js:312`), que es **la implementación de referencia** de los cambios de estado:

- `completada`: `asistio: true`; si hay `precioBase`, calcula `totalPagado` e `importeComision` (con el `comisionPct` del restaurante o `COMISION_PCT`). Si no estaba completada antes: otorga puntos, genera ticket (`emitidoPor: "restaurante-simulado"`), y dispara el check de invitaciones.
- `no_show`: `asistio: false` y **decrementa** `aforo.ocupadas`.
- `cancelada`: si el estado previo no era `cancelada` ni `no_show`, decrementa el aforo y llama `espera().alLiberarseMesa(...)`.
- No valida el valor de `status` en esta capa (`no determinable con el código actual` más allá del comportamiento por estado descrito).

```bash
curl -X PUT "$BASE/v1/dashboard/reservations/Xk2AbC/status" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"completada","precioBase":52.00}'
```

```json
{ "updated": true, "status": "completada" }
```

### 8.12 `POST /v1/dashboard/reservations/:id/confirm-attendance`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/reservations/:id/confirm-attendance` |
| Fichero | `router.js:102` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | **Sin zod**: `{ precioBase? }` |
| Respuesta | `200 { updated: true, status: "completada" }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Atajo de `updateReservationStatus(id, "completada", { precioBase })`.

```bash
curl -X POST "$BASE/v1/dashboard/reservations/Xk2AbC/confirm-attendance" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

```json
{ "updated": true, "status": "completada" }
```

### 8.13 `POST /v1/dashboard/reservations/:id/mark-no-show`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/reservations/:id/mark-no-show` |
| Fichero | `router.js:109` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | — (vacío; se pasa `{}`) |
| Respuesta | `200 { updated: true, status: "no_show" }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Atajo de `updateReservationStatus(id, "no_show", {})`. Marca `asistio: false` y libera la plaza en el aforo.

```bash
curl -X POST "$BASE/v1/dashboard/reservations/Xk2AbC/mark-no-show" -H "Authorization: Bearer $TOKEN"
```

```json
{ "updated": true, "status": "no_show" }
```

### 8.14 `POST /v1/dashboard/reservations/:id/ticket`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/reservations/:id/ticket` |
| Fichero | `router.js:114` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | **Sin zod**: `totalPagado`, `asistio`, `fileName`, `tipoDocumento` |
| Respuesta | `201 { ticketId, comision, neto, estado }` |
| Errores | 400 `VALIDATION_ERROR`; 403 `FORBIDDEN`; 404 `NOT_FOUND`; 409 `CONFLICT`; 500 `INTERNAL_ERROR` |

Duplica el body de `POST /v1/reservations/:id/ticket` y llama directamente a `reservations/service.subirTicket` (`router.js:22`). **No tiene mapeo de errores propio**, pero los errores de `subirTicket` llevan `status`/`code`, así que el `errorHandler` global responde 404/409/400 con su código (era el endpoint que devolvía **siempre 500**: la transacción de `subirTicket` leía `finanzas_restaurante` después de escribir → "read after write").

```bash
curl -X POST "$BASE/v1/dashboard/reservations/Xk2AbC/ticket" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"totalPagado":52.00,"asistio":true}'
```

```json
{ "ticketId": "kX9sQ2m...", "comision": 4.16, "neto": 47.84, "estado": "completada" }
```

### 8.15 `POST /v1/dashboard/points/add-manual`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/points/add-manual` |
| Fichero | `router.js:131` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(addManualSchema)` |
| Roles | `admin` |
| Body | `{ uid: string min 1, cantidad: int −100000..100000, motivo?: string máx 200 }` |
| Respuesta | `200 { ok: true, uid, cantidad, nuevoSaldo }` |
| Errores | `400 VALIDATION_ERROR` (+`details`); 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`addPointsManually` (`service.js:731`) delega en `points/service.addPuntos` con `tipo = "ajuste_admin"` (cantidad ≥ 0) o `"ajuste_admin_negativo"` (< 0), y motivo por defecto `` `Ajuste admin (${+n/-n})` ``. La transacción **impide saldo negativo** (lanza `"Saldo insuficiente"` → 500).

```bash
curl -X POST "$BASE/v1/dashboard/points/add-manual" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uid":"u_1","cantidad":150,"motivo":"Compensación por incidencia"}'
```

```json
{ "ok": true, "uid": "u_1", "cantidad": 150, "nuevoSaldo": 790 }
```

### 8.16 `POST /v1/dashboard/points/racha/set`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/points/racha/set` |
| Fichero | `router.js:142` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(rachaSetSchema)` |
| Roles | `admin` |
| Body | `{ uid: string min 1, dias: int 0..7 }` |
| Respuesta | `200 { ok: true, uid, rachaLogin, saldoActual }` |
| Errores | `400 VALIDATION_ERROR`; `403 FORBIDDEN`; 500 `INTERNAL_ERROR` |

`setRachaAdmin` (`service.js:743`) fija `rachaLoginDias = clamp(dias, 0, 7)`, `ultimoLoginDate` = **ayer** en `Europe/Madrid` (para que hoy siga reclamable) y `graceUsados = 0`. Devuelve el `getBalance` resultante: la respuesta incluye el objeto `rachaLogin` completo y `saldoActual`.

```bash
curl -X POST "$BASE/v1/dashboard/points/racha/set" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uid":"u_1","dias":7}'
```

```json
{ "ok": true, "uid": "u_1", "rachaLogin": { "dias": 7, "ultimoLogin": "2026-10-08", "graceUsados": 0, "yaReclamado": false, "puntosHoy": 0, "dia7Disponible": true, "diasTrasReclamo": 7 }, "saldoActual": 790 }
```

### 8.17 `POST /v1/dashboard/points/racha/delta`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/points/racha/delta` |
| Fichero | `router.js:153` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(rachaDeltaSchema)` |
| Roles | `admin` |
| Body | `{ uid: string min 1, delta: int −7..7, refinado a ≠ 0 }` |
| Respuesta | `200 { ok: true, uid, delta, rachaLogin }` |
| Errores | `400 VALIDATION_ERROR` (`"delta no puede ser 0"`); `403 FORBIDDEN`; 500 `INTERNAL_ERROR` |

`ajustarRachaDias` (`service.js:762`) suma el delta con clamp `0..7`. Si el `delta` es negativo y el usuario ya había reclamado hoy, retrocede `ultimoLoginDate` a ayer para devolverle el reclamo.

```bash
curl -X POST "$BASE/v1/dashboard/points/racha/delta" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uid":"u_1","delta":-2}'
```

```json
{ "ok": true, "uid": "u_1", "delta": -2, "rachaLogin": { "dias": 1, "ultimoLogin": "2026-10-08", "graceUsados": 0, "yaReclamado": false, "puntosHoy": 5, "dia7Available": false } }
```

### 8.18 `POST /v1/dashboard/points/racha/unclaim-today`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/dashboard/points/racha/unclaim-today` |
| Fichero | `router.js:159` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(z.object({ uid: z.string().min(1) }))` |
| Roles | `admin` |
| Body | `{ uid: string min 1 }` |
| Respuesta | `200 { ok: true, uid, estabaReclamadoHoy, rachaLogin, aviso }` |
| Errores | `400 VALIDATION_ERROR`; `403 FORBIDDEN`; 500 `INTERNAL_ERROR` |

`unclaimLoginHoy` (`service.js:784`) **deshace** el login de hoy: pone `ultimoLoginDate = ayer` y, si estaba reclamado hoy, `rachaLoginDias = max(0, dias − 1)`. **No devuelve los puntos ya abonados** (no hay transacción de reversión del saldo). La respuesta incluye el texto `aviso: "Si el frontend tenía caché de sesión, recarga la página del cliente."`.

```bash
curl -X POST "$BASE/v1/dashboard/points/racha/unclaim-today" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"uid":"u_1"}'
```

```json
{ "ok": true, "uid": "u_1", "estabaReclamadoHoy": true, "rachaLogin": { "dias": 2, "ultimoLogin": "2026-10-08", "graceUsados": 0 }, "aviso": "Si el frontend tenía caché de sesión, recarga la página del cliente." }
```

### 8.19 `GET /v1/dashboard/users`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/dashboard/users` |
| Fichero | `router.js:171` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 UsuarioResumen[]` (**array pelado**) |
| Errores | `403 FORBIDDEN`; 500 `INTERNAL_ERROR` |

Importa `getAllUsers` desde `../users/service` (`router.js:21`). Es funcionalmente idéntico a `GET /v1/users/all`; duplica la lectura completa de la colección `usuarios`.

```bash
curl "$BASE/v1/dashboard/users" -H "Authorization: Bearer $TOKEN"
```

---

## 9. Administración (finanzas y fraude) — `/v1/admin`

Router: `src/modules/admin/routes.js`. Servicio: `src/modules/admin/service.js`.

### 9.1 `GET /v1/admin/revenue`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/admin/revenue` |
| Fichero | `routes.js:7` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Query | `from`, `to` (fechas ISO; se convierten con `new Date(...)`) |
| Body | — |
| Respuesta | `200 { total, comisiones, tickets, totalComision, porRestaurante }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getRevenue` (`service.js:4`) filtra por `createdAt` en `[from, to]` (ambos opcionales), ordena descendente y **limita a 500 tickets**. `porRestaurante` es un mapa `restaurantId → { comision, tickets, nombre }`.

`comisiones` y `totalComision` devuelven **el mismo valor** (duplicado en el service, `service.js:29` y `:31`).

```bash
curl "$BASE/v1/admin/revenue?from=2026-09-01&to=2026-09-30" -H "Authorization: Bearer $TOKEN"
```

```json
{ "total": 51200.5, "comisiones": 4096.04, "tickets": 1042, "totalComision": 4096.04, "porRestaurante": { "r_abc": { "comision": 320.5, "tickets": 68, "nombre": "Green Bowl" } } }
```

### 9.2 `GET /v1/admin/fraud-flags`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/admin/fraud-flags` |
| Fichero | `routes.js:16` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { data: { id, ...campos }[] }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getFraudFlags` (`service.js:36`) lee `fraudFlags` ordenada por `createdAt` descendente, **limit 100**, sin filtro de estado.

El service exporta además `crearFraudFlag` y `resolverFraudFlag`, pero **no hay endpoint que las invoque** (`no determinable con el código actual` quién las consume).

```bash
curl "$BASE/v1/admin/fraud-flags" -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": [ { "id": "f_1", "uid": "u_9", "tipo": "ticket_duplicado", "detalle": { "reservaId": "Xk2AbC" }, "estado": "abierto", "createdAt": "2026-10-07T09:00:00.000Z" } ] }
```

---

## 10. Reseñas — `/v1/reviews`

Router: `src/modules/reviews/routes.js`. Servicio: `src/modules/reviews/service.js`. Colección Firestore: `resenas`.

### 10.1 `POST /v1/reviews`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/reviews` |
| Fichero | `routes.js:15` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(crearSchema)` |
| Roles | — |
| Body | `{ restauranteId: string 1..200 sin slash, puntuacion: int 1..5, comentario: string trim 1..4000 }` |
| Respuesta | `201 { id, reviewId, …puntos }` |
| Errores | `400 VALIDATION_ERROR` (+`details` o con `message`); 500 `INTERNAL_ERROR` |

El handler lee `usuarios/{uid}` para el nombre (usa `userData.nombre`, y si no el `email` del token) y luego, **best-effort**, llama `points/service.reviewPoints(uid)` (+20 puntos) envolviéndolo en su propio `try/catch`. Si esa parte falla, la reseña **ya está creada** y la respuesta sale sin los campos de puntos.

`puntosResult` de `reviewPoints` es `{ puntos: 20, nuevoSaldo }`, así que la respuesta incluye ambos.

Mapeo de errores: mensajes con `"Puntuación"` o `"comentario"` → `400 VALIDATION_ERROR`.

```bash
curl -X POST "$BASE/v1/reviews" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restauranteId":"r_abc","puntuacion":5,"comentario":"Excelente carta vegetal y muy buena atención."}'
```

```json
{ "id": "rv_1", "reviewId": "rv_1", "puntos": 20, "nuevoSaldo": 660 }
```

### 10.2 `GET /v1/reviews/user/:usuarioId`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/reviews/user/:usuarioId` |
| Fichero | `routes.js:41` |
| Auth | **Ninguna** (sin middleware) |
| Roles | — |
| Path | `usuarioId` |
| Body | — |
| Respuesta | `200 Reseña[]` (**array pelado**) |
| Errores | 500 `INTERNAL_ERROR` |

Ordena por `createdAt` descendente. Con el código actual el `usuarioId` es un identificador arbitrario en la ruta, no está atado al token.

```bash
curl "$BASE/v1/reviews/user/u_1"
```

### 10.3 `GET /v1/reviews/:restauranteId`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/reviews/:restauranteId` |
| Fichero | `routes.js:50` |
| Auth | **Ninguna** |
| Roles | — |
| Path | `restauranteId` |
| Body | — |
| Respuesta | `200 { data: Reseña[] }` |
| Errores | 500 `INTERNAL_ERROR` |

Ordena por `likes` descendente y, a empate, por `puntuacion` descendente.

```bash
curl "$BASE/v1/reviews/r_abc"
```

### 10.4 `POST /v1/reviews/:id/like`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/reviews/:id/like` |
| Fichero | `routes.js:59` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok": true}` |
| Errores | `404 {"error":"NOT_FOUND"}`; 500 `INTERNAL_ERROR` |

`darLike` (`service.js:37`) en transacción: añade el uid a `likedBy` e incrementa `likes`.

```bash
curl -X POST "$BASE/v1/reviews/rv_1/like" -H "Authorization: Bearer $TOKEN"
```

### 10.5 `DELETE /v1/reviews/:id/like`

| Campo | Valor |
|---|---|
| Método / Ruta | `DELETE /v1/reviews/:id/like` |
| Fichero | `routes.js:69` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok": true}` |
| Errores | `404 {"error":"NOT_FOUND"}`; 500 `INTERNAL_ERROR` |

`quitarLike` (`service.js:52`): quita el uid de `likedBy` y decrementa `likes`.

```bash
curl -X DELETE "$BASE/v1/reviews/rv_1/like" -H "Authorization: Bearer $TOKEN"
```

---

## 11. Invitaciones — `/v1/invite`

Router: `src/modules/invitations/routes.js`. Servicio: `src/modules/invitations/service.js`. Colección: `invitaciones`.

Flujo: un cliente genera un código (8 caracteres sin vocales ambiguas) para un email; el invitado lo acepta y, tras `INVITACIONES_RESERVAS_REQUERIDAS` (2) reservas completadas, ambos reciben `PUNTOS_INVITACION` (200). `onInvitadoReservaCompletada` es invocado desde `reservations/service` al completar una reserva.

### Configuración Brevo HTTPS de invitaciones (BUG-120)

El servicio guarda primero la invitación en Firestore y después envía el correo con `fetch` nativo de Node (sin dependencias de correo): `POST https://api.brevo.com/v3/smtp/email`, cabecera `api-key`, `sender`, `to`, `subject`, `textContent` y `htmlContent`. Ambas versiones incluyen el código y el enlace `FRONTEND_URL/#/registro?invite=CODIGO`. El HTML escapa los valores dinámicos. Timeout de 15 segundos. [API de Brevo](https://developers.brevo.com/docs/send-a-transactional-email).

La validación inicial del destinatario sigue siendo exclusivamente de formato. El envío y su existencia se conocen después mediante Brevo; no se consulta DNS ni se promete entrega inmediata. Se persisten `messageId` y `emailEstado`: `enviado` si Brevo acepta el mensaje con identificador, `no_enviado` si falta clave/remitente o hay error, `inexistente` ante los eventos del webhook indicados abajo. `enviado` significa aceptado por el proveedor, no entregado al buzón. Sin clave o con error se conserva la invitación y se devuelve 201; el log contiene un aviso sin clave ni cuerpo de respuesta. No hay reintentos automáticos.

**Render:** en el servicio mira-api, Environment, eliminar las variables `SMTP_*` antiguas y configurar:

| Variable | Valor |
|---|---|
| `BREVO_API_KEY` | Clave API de Brevo, solo en Environment de Render |
| `MAIL_FROM` | Remitente verificado en Brevo: `cuenta@dominio.tld` o `MIRA <cuenta@dominio.tld>` |
| `BREVO_WEBHOOK_TOKEN` | Secreto aleatorio largo; usar el mismo valor en la URL del webhook |
| `FRONTEND_URL` | URL HTTPS pública del frontend sin hash ni ruta de registro |

Redesplegar backend y frontend. La API HTTPS usa el puerto 443 y funciona con Render Free; no utiliza SMTP ni Nodemailer. El backend no tiene fase de build/transpilación: instalar dependencias y usar `npm start`; pruebas con `npm test`.

**Brevo:**

1. Crear/iniciar sesión en la cuenta y habilitar el envío transaccional si Brevo solicita activación. Añadir/verificar el remitente (y autenticar el dominio si se utiliza un dominio propio).
2. En la configuración de claves API, generar una clave para este servicio y guardarla como `BREVO_API_KEY` en Render. No usar una clave SMTP ni publicar la clave en Git/frontend.
3. En Email transaccional → configuración de webhooks, crear un webhook transaccional **sin agrupación de eventos** hacia `https://<backend-render>/v1/invite/webhook/brevo?token=<BREVO_WEBHOOK_TOKEN_URL_ENCODED>`.
4. Seleccionar **Hard bounce, Invalid email, Blocked y Error**. Los nombres del payload son `hard_bounce`, `invalid_email`, `blocked` y `error`. **BUG-122:** añadir Error también al webhook ya existente; Brevo puede aceptar inicialmente un envío con 201/messageId y rechazarlo después (por ejemplo, remitente sin verificar). El token de la URL debe coincidir exactamente con la variable de Render; codificarlo para URL.
5. Después del despliegue, enviar una invitación de prueba y verificar su `messageId`/`emailEstado` y los logs transaccionales de Brevo. Probar el webhook y recargar la lista para ver el resultado. Las cuotas/límites aplicables son los de la cuenta Brevo.

`GET /v1/invite/my` recupera las enviadas del usuario autenticado, incluidos los campos de entrega. Se ordenan en memoria por `createdAt` para no requerir un índice compuesto. El panel espera Firebase Auth después de F5 y vuelve a solicitar la lista; Mi cuenta también la carga al montar con sesión. El estado `inexistente` muestra «No existe la dirección, compruebe antes de volver a enviar» en la invitación; `no_enviado` indica que el correo no pudo enviarse. Traducciones es/ca/en. Los registros antiguos sin `emailEstado` permanecen consultables sin inventar una etiqueta de entrega.

### 11.1 `POST /v1/invite`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/invite` |
| Fichero | `routes.js:12` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(inviteSchema)` |
| Roles | — |
| Body | `{ email?: email, emailInvitado?: email }` (al menos uno) |
| Respuesta | `201 { id, codigo, email, estado: "pendiente", messageId: string | null, emailEstado }` |
| Errores | `400 VALIDATION_ERROR` (+`details` en el refine), `400 SELF_INVITE`, `429 RATE_LIMITED`, 500 `INTERNAL_ERROR` |

`crearInvitacion` (`service.js:5`):

- Si el email coincide con el del usuario (case-insensitive) → `"No puedes invitarte a ti mismo"` → **400 SELF_INVITE**.
- Si ya creó `INVITACIONES_MAX_MES` (5) invitaciones en el mes natural actual → `` `Límite de ${n} invitaciones por mes` `` → **429 RATE_LIMITED**.

```bash
curl -X POST "$BASE/v1/invite" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"amigo@example.com"}'
```

```json
{ "id": "inv_1", "codigo": "K7mQ2rBx", "email": "amigo@example.com", "estado": "pendiente" }
```

### 11.2 `POST /v1/invite/accept`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/invite/accept` |
| Fichero | `routes.js:25` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(acceptSchema)` |
| Roles | — |
| Body | `{ codigo: string min 4 }` |
| Respuesta | `200` resultado de `aceptarInvitacion` |
| Errores | `404 NOT_FOUND`, `409 ALREADY_USED`, `403 FORBIDDEN`, 500 `INTERNAL_ERROR` |

Mapeo por texto de mensaje:

| Mensaje contiene | Estado | Cuerpo |
|---|---|---|
| `"no válida"` o `"no encontrada"` | `404` | `{"error":"NOT_FOUND","message":…}` |
| `"ya usada"` o `"ya utilizada"` | `409` | `{"error":"ALREADY_USED"}` |
| `"para ti"` | `403` | `{"error":"FORBIDDEN","message":…}` |

El código se busca por `where("codigo","==",…)`. La forma exacta del objeto devuelto por `aceptarInvitacion` depende de la lógica interna (`service.js:39`), que en el código leído no expone un esquema de respuesta cerrado.

```bash
curl -X POST "$BASE/v1/invite/accept" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"codigo":"K7mQ2rBx"}'
```

### 11.3 `GET /v1/invite/my`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/invite/my` |
| Fichero | `routes.js:37` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200` resultado de `getMyInvites(uid)` (`service.js:112`) |
| Errores | 500 `INTERNAL_ERROR` |

Devuelve las invitaciones creadas por el usuario **y** las que ha aceptado (`no determinable con el código actual` la forma exacta del array: `getMyInvites` no se ha desglosado más allá de su firma).

```bash
curl "$BASE/v1/invite/my" -H "Authorization: Bearer $TOKEN"
```

---

### 11.4 `POST /v1/invite/webhook/brevo?token=SECRETO`

Endpoint público sin Firebase Auth, protegido por `BREVO_WEBHOOK_TOKEN`. Compara hashes SHA-256 de longitud fija con `crypto.timingSafeEqual`. Token incorrecto/ausente o secreto de servidor no configurado devuelve 401. Límite: 120 peticiones/minuto por IP (además del global). Zod valida el evento y, para los eventos utilizados, `email` y `message-id` opcionales con límites de longitud; los demás campos se ignoran. El logger de peticiones elimina la query para no registrar el token.

Los eventos desconocidos devuelven 200 inmediatamente sin consultar Firestore. Para `hard_bounce`, `invalid_email` y `blocked` se busca por `messageId` (admite identificador con/sin corchetes angulares); si no coincide, por email normalizado y la invitación pendiente más reciente, ordenada en memoria. Una transacción establece `emailEstado: "inexistente"` solo si la invitación sigue pendiente y sin aceptación. El evento `error` utiliza la misma búsqueda y establece `emailEstado: "no_enviado"`, sin sobrescribir `inexistente`. No se guarda ni se registra el campo `reason` completo; Zod lo descarta. Solo se conserva `emailEvento`, uno de los cuatro códigos conocidos, para evitar que una respuesta de envío tardía sobrescriba un error recibido durante el envío. No modifica `aceptada` ni `esperando_2_reservas`, tampoco cae al fallback si el identificador corresponde a una aceptada. Repetir un evento es seguro. Sin coincidencia devuelve 200; un fallo de Firestore devuelve 500 para que el proveedor pueda reintentar. No hay índices compuestos nuevos.

Este estado agrupa los tres eventos por decisión funcional del BUG-120; `blocked` puede indicar una dirección bloqueada, no necesariamente un buzón inexistente. [Eventos transaccionales de Brevo](https://developers.brevo.com/docs/transactional-webhooks).

```json
{ "event": "hard_bounce", "email": "amigo@example.com", "message-id": "<identificador@brevo>" }
```


## 12. Promociones — `/v1/promotions`

Router: `src/modules/promotions/routes.js`. Servicio: `src/modules/promotions/service.js`. Colección: `promociones`.

### 12.1 `GET /v1/promotions`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/promotions` |
| Fichero | `routes.js:9` |
| Auth | **Ninguna** (sin middleware) |
| Roles | — |
| Query | `restauranteId`, `estado` |
| Body | — |
| Respuesta | `200 { data: Promocion[] }` |
| Errores | 500 `INTERNAL_ERROR` |

```bash
curl "$BASE/v1/promotions?estado=activa"
```

### 12.2 `POST /v1/promotions`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/promotions` |
| Fichero | `routes.js:30` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(crearPromoSchema)` |
| Roles | `empresa`, `admin` |
| Body | `crearPromoSchema` (zod) |
| Respuesta | `201 { id }` |
| Errores | `400 VALIDATION_ERROR` (+`details`), `403 FORBIDDEN`, `409 CONFLICT`, 500 `INTERNAL_ERROR` |

Esquema (`routes.js:21`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `restauranteId` | `string` min 1 | Sí |
| `fechaInicio` | `string` | Sí |
| `fechaFin` | `string` | Sí |
| `presupuestoTotal` | `number` > 0 | Sí |
| `tipo` | `string` | No (def. `"boost_visibilidad"`) |
| `cpc` | `number` > 0 | No (def. `0.20`) |
| `puntosExtraPorReserva` | `int` | No (def. `0`) |

`crearPromocion` (`service.js:4`):

- Restaurante inexistente → `404 NOT_FOUND`.
- Si el restaurante tiene `ownerUid` y no coincide con el uid → `"No eres dueño de este restaurante"` → **403 FORBIDDEN**. Si el restaurante **no** tiene `ownerUid`, la comprobación se salta.
- Si ya hay una promoción `activa` para ese restaurante → `"Ya hay una promoción activa para este restaurante"` → **409 CONFLICT**.
- Crea con `estado: "activa"`, `prioridad: 100`, contadores a cero.

```bash
curl -X POST "$BASE/v1/promotions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restauranteId":"r_abc","fechaInicio":"2026-10-01","fechaFin":"2026-10-31","presupuestoTotal":300,"cpc":0.25}'
```

```json
{ "id": "pr_1" }
```

### 12.3 `GET /v1/promotions/:id/stats`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/promotions/:id/stats` |
| Fichero | `routes.js:41` |
| Auth | `verifyFirebaseAuth` |
| Roles | `empresa`, `admin` |
| Path | `id` |
| Body | — |
| Respuesta | `200 getPromoStats(promoId)` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

`getPromoStats` (`service.js:80`). **No hay comprobación de propiedad** del restaurante en esta ruta: cualquier `empresa` puede pedir las estadísticas de cualquier promoción por id.

```bash
curl "$BASE/v1/promotions/pr_1/stats" -H "Authorization: Bearer $TOKEN"
```

---

## 13. Interacciones con promociones — `/v1/interactions`

Router: `src/modules/interactions/routes.js`. Servicio: `src/modules/interactions/service.js`.

### 13.1 `POST /v1/interactions`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/interactions` |
| Fichero | `routes.js:14` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(interactionSchema)` |
| Roles | — |
| Body | `{ restauranteId: string min 1, tipo: enum("view","click") }` |
| Respuesta | Ver tabla de casos |
| Errores | `400 VALIDATION_ERROR` (+`details`); `404 NO_PROMO`; 500 `INTERNAL_ERROR` |

| Caso | Estado | Cuerpo |
|---|---|---|
| Interacción registrada | `201` | `resultado` del service: `{ puntos, nuevoSaldo }` |
| Sin promoción activa | `404` | `{"error":"NO_PROMO","message":"No hay promoción activa"}` |
| `view` ya registrada antes | `200` | `{"puntos":0,"message":"Ya registrado"}` |

`registrarVista` (`service.js:7`): exige promoción activa; si ya existe **cualquier** movimiento `promo_view` del usuario (no depende del restaurante), devuelve `yaVisto`. `registrarClick` (`service.js:24`): no tiene deduplicación, cada clic suma puntos.

Puntos: `PUNTOS_PROMO_VIEW` (2) para vista, `PUNTOS_PROMO_CLICK` (5) para clic.

Auditoría: el handler registra un evento `interaccion` (`origen: "api"`, `entidadTipo: "restaurante"`, `accion: tipo`, `datos: { interaccion, puntos, sinPromo }`) **antes** de devolver la respuesta, incluso en el caso 404.

```bash
curl -X POST "$BASE/v1/interactions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restauranteId":"r_abc","tipo":"click"}'
```

```json
{ "puntos": 5, "nuevoSaldo": 665 }
```

---

## 14. Tickets — `/v1/tickets`

Router: `src/modules/tickets/routes.js`. Servicio: `src/modules/tickets/service.js`. Colección: `tickets`.

### 14.1 `GET /v1/tickets`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/tickets` |
| Fichero | `routes.js:7` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { data: Ticket[] }` |
| Errores | 500 `INTERNAL_ERROR` |

`getTicketsByUser(uid, { page = 1, limit = 20 })` (`service.js:64`): `where("uid","==",uid).orderBy("createdAt","desc").limit(20)`. **La ruta no pasa `page` ni `limit`**: siempre 20 y sin paginación.

```bash
curl "$BASE/v1/tickets" -H "Authorization: Bearer $TOKEN"
```

### 14.2 `GET /v1/tickets/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/tickets/:id` |
| Fichero | `routes.js:16` |
| Auth | `verifyFirebaseAuth` |
| Roles | El service comprueba: dueño (`ticket.uid === uid`), **o** rol `admin`, **o** rol `empresa` |
| Path | `id` |
| Body | — |
| Respuesta | `200 { id, ...camposDelTicket }` |
| Errores | `404 {"error":"NOT_FOUND"}`; `403 {"error":"FORBIDDEN"}`; 500 `INTERNAL_ERROR` |

Control de acceso (`service.js:58`): cualquier `empresa` autenticada puede leer **cualquier** ticket por id; la comparación es por rol, no por `restaurantId`.

```bash
curl "$BASE/v1/tickets/t_1" -H "Authorization: Bearer $TOKEN"
```

---

## 15. Propuesta de negocios — `/v1/negocios`

Router: `src/modules/negocios/routes.js`. Servicio: `src/modules/negocios/service.js`. Colección: `negocios`.

Ciclo de vida: `POST /` crea en `estado: "pendiente"`; el admin la aprueba (`PUT /:id/aprobar`, que devuelve el `restaurantId` generado) o la rechaza.

### 15.1 `POST /v1/negocios`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/negocios` |
| Fichero | `routes.js:27` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | `validate(proponerSchema)` |
| Roles | — |
| Body | `proponerSchema` (zod) |
| Respuesta | `201 { id }` |
| Errores | `400 VALIDATION_ERROR` (+`details` o con `message`); 500 `INTERNAL_ERROR` |

Esquema (`routes.js:9`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `nombre`, `ciudad`, `zona`, `direccion` | `string` min 1 | Sí |
| `precio` | `enum("€","€€","€€€")` | Sí |
| `categorias` | `string[]` min 1 | Sí |
| `telefono`, `descripcion`, `imagen_url`, `alergenos` | `string` | No |
| `accesoDiscapacidad`, `menuInfantil`, `entornoTranquilo`, `tronas`, `terraza` | `boolean \| null` | No (def. `null`) |

`proponerNegocio` (`service.js:17`) valida de nuevo los 6 campos obligatorios y guarda `uid`, `email`, `estado: "pendiente"` y `creado`.

Mapeo de errores del handler: mensajes con `"obligatorio"`, `"Elige"`, `"no válido"` o `"Indica"` → `400 VALIDATION_ERROR`.

```bash
curl -X POST "$BASE/v1/negocios" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nombre":"Casa Verde","ciudad":"Valencia","zona":"Russafa","direccion":"Carrer de Cadis 12","precio":"€€","categorias":["Vegetariano","Mediterránea"],"terraza":true}'
```

```json
{ "id": "ng_1" }
```

### 15.2 `GET /v1/negocios/my`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/negocios/my` |
| Fichero | `routes.js:43` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { data: Negocio[] }` |
| Errores | 500 `INTERNAL_ERROR` |

Ordena por `creado` descendente.

```bash
curl "$BASE/v1/negocios/my" -H "Authorization: Bearer $TOKEN"
```

### 15.3 `GET /v1/negocios/pendientes`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/negocios/pendientes` |
| Fichero | `routes.js:52` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { data: Negocio[] }` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Sin orden explícito: sale en el orden natural de la consulta de Firestore.

```bash
curl "$BASE/v1/negocios/pendientes" -H "Authorization: Bearer $TOKEN"
```

### 15.4 `PUT /v1/negocios/:id/aprobar`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/negocios/:id/aprobar` |
| Fichero | `routes.js:61` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Path | `id` |
| Body | — |
| Respuesta | `200 { ok: true, restaurantId }` |
| Errores | `404 NOT_FOUND` ("ya no existe"), `409 CONFLICT` ("aprobada"), 403 `FORBIDDEN`, 500 `INTERNAL_ERROR` |

`aprobarNegocio` (`service.js:59`) crea el documento en `restaurants` y devuelve su id como `restaurantId`.

```bash
curl -X PUT "$BASE/v1/negocios/ng_1/aprobar" -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true, "restaurantId": "r_new1" }
```

### 15.5 `PUT /v1/negocios/:id/rechazar`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/negocios/:id/rechazar` |
| Fichero | `routes.js:72` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok":true,"estado":"rechazada"}` |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Sin mapeo específico de errores: un id inexistente acaba en 500.

```bash
curl -X PUT "$BASE/v1/negocios/ng_2/rechazar" -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true, "estado": "rechazada" }
```

---

## 16. Contacto e incidencias — `/v1/contactos`

Router: `src/modules/contactos/routes.js`. Servicio: `src/modules/contactos/service.js`. Colección: `contactos`.

### 16.1 `POST /v1/contactos`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/contactos` |
| Fichero | `routes.js:16` |
| Auth | `optionalAuth` (acepta anónimos) |
| Middlewares | `validate(crearSchema)` |
| Roles | — |
| Body | `{ nombre: string min 1, email: email, motivo: string min 1, mensaje: string min 1 }` |
| Respuesta | `201 { id }` |
| Errores | `400 VALIDATION_ERROR` (+`details`); 500 `INTERNAL_ERROR` |

`crearContacto` (`service.js:4`) guarda `uid` (`null` si anónimo), `estado: "pendiente"` y `creado`.

```bash
curl -X POST "$BASE/v1/contactos" \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Ana","email":"ana@example.com","motivo":"Problema con una reserva","mensaje":"Mi reserva del 15 aparece cancelada y no sé por qué."}'
```

```json
{ "id": "ct_1" }
```

### 16.2 `GET /v1/contactos/mine`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/contactos/mine` |
| Fichero | `routes.js:28` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { id, ... }[]` (**array pelado**) |
| Errores | 500 `INTERNAL_ERROR` |

```bash
curl "$BASE/v1/contactos/mine" -H "Authorization: Bearer $TOKEN"
```

### 16.3 `GET /v1/contactos/pending`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/contactos/pending` |
| Fichero | `routes.js:37` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { id, ... }[]` (**array pelado**) |
| Errores | 403 `FORBIDDEN`; 500 `INTERNAL_ERROR` |

Ordena por `creado` **ascendente** (las más antiguas primero).

```bash
curl "$BASE/v1/contactos/pending" -H "Authorization: Bearer $TOKEN"
```

### 16.4 `PUT /v1/contactos/:id/resolve`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/contactos/:id/resolve` |
| Fichero | `routes.js` (`resolverSchema`) |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Path | `id` |
| Body | `{ propuestaResolucion, solucion, encargado }` — los tres obligatorios |
| Respuesta | `200 { ok: true, id, ...incidenciaActualizada }` (fechas nuevas en ISO; Firestore puede serializar las existentes como Timestamp) |
| Errores | 400 `VALIDATION_ERROR` (falta un campo, está vacío o supera el límite); 403 `FORBIDDEN`; 404 si no existe; 409 si ya está resuelta; 500 `INTERNAL_ERROR` |

Resolver una incidencia ya **no es un solo clic**: el panel admin abre un popup que pide los tres campos y solo al confirmar llama a este endpoint.

| Campo | Tipo | Límite | Significado |
|---|---|---|---|
| `propuestaResolucion` | string | 1–4000 | Qué se propone hacer con la incidencia |
| `solucion` | string | 1–4000 | Qué se ha hecho finalmente |
| `encargado` | string | 1–200 | Persona responsable de la resolución |

Los valores se recortan (`trim`); solo espacios cuenta como vacío. El servicio los valida de nuevo y guarda en una transacción los tres campos, `estado: "resuelta"`, `resueltoPor` (UID del administrador autenticado), `resueltoPorNombre` (nombre del perfil o UID) y `resueltaEn` (fecha del servidor). El encargado escrito en el formulario no sustituye al administrador que resolvió. Un id inexistente devuelve 404; una incidencia ya resuelta devuelve 409 sin sobrescribir su historial.

La herramienta de IA `resolveContacto` (`ai/tools.js`, deshabilitada) exige los mismos tres campos.

**Despliegue:** frontend y backend van acoplados. Un frontend anterior al cambio no envía body y recibiría 400; desplegar siempre el frontend antes o a la vez.

```bash
curl -X PUT "$BASE/v1/contactos/ct_1/resolve" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"propuestaResolucion":"Llamar al cliente","solucion":"Abono del 10 %","encargado":"Ana"}'
```

```json
{ "ok": true, "id": "ct_1", "estado": "resuelta", "resueltoPor": "uid-admin", "resueltoPorNombre": "Ana", "resueltaEn": "2026-10-14T10:00:00.000Z", "solucion": "Abono del 10 %", "encargado": "Ana", "propuestaResolucion": "Llamar al cliente" }
```

---

## 17. Mensajes — `/v1/mensajes`

Router: `src/modules/mensajes/routes.js`. Servicio: `src/modules/mensajes/service.js`. Colección: `mensajes`.

Los mensajes los escribe el admin desde `POST /v1/dashboard/restaurant/:id/message`; además `espera/service` notifica cuando se libera una plaza de la lista de espera.

### 16.5 `GET /v1/contactos/resolved`

Requiere `verifyFirebaseAuth` y rol `admin`. Devuelve un array de contactos con `estado: "resuelta"`, incluidos los datos originales, `propuestaResolucion`, `solucion`, `encargado`, `resueltoPor`, `resueltoPorNombre` y `resueltaEn` cuando existan. Orden descendente por fecha de resolución, realizado en memoria: no necesita un índice compuesto nuevo. Sin sesión devuelve 401 y un usuario no administrador recibe 403.

Admin > Incidencias consume este endpoint en la vista Resueltas. Tanto `Admin.jsx` como `OpsIncidencias.jsx` aíslan el fallo de cada listado con `.catch(() => [])`: si el historial falla, pendientes y negocios siguen disponibles. Los filtros de texto y fecha son locales y los gráficos Recharts utilizan el conjunto filtrado: cantidad por UID del administrador, duración media por persona y evolución diaria de la media (horas entre `creado` y `resueltaEn`). Los días se agrupan en UTC. Los registros anteriores sin autor/fecha permanecen consultables; no se atribuyen al encargado ni se incluyen en medias sin fechas válidas.

**Render (BUG-121):** desplegar el backend antes o junto al frontend. No se requieren variables de entorno nuevas, migración de registros antiguos ni índices nuevos para este endpoint.

### 17.1 `GET /v1/mensajes`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/mensajes` |
| Fichero | `routes.js:7` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 Mensaje[]` (**array pelado**), orden `creado` descendente |
| Errores | 500 `INTERNAL_ERROR` |

Filtrado por `mensajes.uid == uid`. Los mensajes sin `uid` (los que el admin dejó pendientes de entrega por email) **no** aparecen aquí.

```bash
curl "$BASE/v1/mensajes" -H "Authorization: Bearer $TOKEN"
```

### 17.2 `GET /v1/mensajes/unread-count`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/mensajes/unread-count` |
| Fichero | `routes.js:16` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 {"count": number}` |
| Errores | 500 `INTERNAL_ERROR` |

Cuenta en memoria los mensajes con `leido !== true` (no consulta con filtro).

```bash
curl "$BASE/v1/mensajes/unread-count" -H "Authorization: Bearer $TOKEN"
```

```json
{ "count": 2 }
```

### 17.3 `PUT /v1/mensajes/:id/read`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/mensajes/:id/read` |
| Fichero | `routes.js:25` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok": true}` |
| Errores | 500 `INTERNAL_ERROR` |

`marcarLeido` (`service.js:19`) hace `update({ leido: true })` sobre el id dado. **No comprueba que el mensaje pertenezca al usuario**: con el código actual, cualquier autenticado puede marcar como leído el mensaje de otro.

```bash
curl -X PUT "$BASE/v1/mensajes/msg_1/read" -H "Authorization: Bearer $TOKEN"
```

---

## 18. Lista de espera — `/v1/espera`

Router: `src/modules/espera/routes.js`. Servicio: `src/modules/espera/service.js`. Colección: `espera`.

Modelo: documento por persona y franja con id fijo `espera/{restauranteId}_{fecha}_{hora}_{uid}` (apuntarse dos veces no duplica). Cuando se libera una mesa, se avisa al primero de la cola y se le **retiene la plaza 30 minutos** (`RETENCION_MS`) en `aforo.retenidas`; `crearReserva` ya lee ese mapa, de modo que retener no cuesta lecturas extra al reservar.

### 18.1 `POST /v1/espera`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/espera` |
| Fichero | `routes.js:27` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | **`rateLimit(60000, 20)`**, `validate(unirseSchema)` |
| Roles | — |
| Body | `{ restauranteId: string 1..120, fecha: YYYY-MM-DD, hora: HH:MM, comensales: coerce int 1..10 }` |
| Respuesta | `201` si se apunta por primera vez; `200` si ya estaba (`yaEstabas: true`) |
| Errores | `429 RATE_LIMITED`; `404 NOT_FOUND`; `400 VALIDATION_ERROR`; `409 HAY_SITIO`; 500 `INTERNAL_ERROR` |

Orden de middlewares: `verifyFirebaseAuth` → `rateLimit` → `validate` → handler. El `rateLimit` **se ejecuta antes** de validar, así que una petición inválida también consume cuota.

`unirse` (`service.js:51`):

1. `hora ∉ SLOTS` → `400 VALIDATION_ERROR` ("Hora no válida").
2. `fecha` no válida o franja ya pasada → `400 VALIDATION_ERROR` ("Esa franja ya ha pasado").
3. `comensales` no entero o fuera de `1..10` → `400 VALIDATION_ERROR`.
4. **`libres > 0` en la franja** → `409 HAY_SITIO` con `"Hay mesa libre en esa franja: puedes reservar directamente."`
5. Si ya hay documento con estado `esperando` o `avisado` → `200` con `{ …, yaEstabas: true }`.
6. Si no, crea con `estado: "esperando"`.

El handler carga antes el restaurante con `restaurantsService.obtenerRestaurante` y, si es `null`, responde `404 {"error":"NOT_FOUND","message":"Restaurante no encontrado"}`. Calcula el límite con `limiteDelLocal(restaurante)`.

El `nombre` enviado es el prefijo del email del token antes de `@`.

```bash
curl -X POST "$BASE/v1/espera" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restauranteId":"r_abc","fecha":"2026-10-15","hora":"21:00","comensales":2}'
```

```json
{ "id": "r_abc_2026-10-15_21:00_u_1", "uid": "u_1", "nombre": "ana", "clave": "r_abc_2026-10-15_21:00", "restauranteId": "r_abc", "restauranteNombre": "Green Bowl", "fecha": "2026-10-15", "hora": "21:00", "comensales": 2, "estado": "esperando", "creado": "2026-10-09T08:00:00.000Z" }
```

### 18.2 `GET /v1/espera/mias`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/espera/mias` |
| Fichero | `routes.js:39` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { items: Espera[] }` |
| Errores | 500 `INTERNAL_ERROR` |

`listarMias` (`service.js:83`) devuelve solo las entradas en estado `esperando` o `avisado` **y** con franja futura, ordenadas por `fecha`+`hora` ascendente.

```bash
curl "$BASE/v1/espera/mias" -H "Authorization: Bearer $TOKEN"
```

### 18.3 `DELETE /v1/espera/:id`

| Campo | Valor |
|---|---|
| Método / Ruta | `DELETE /v1/espera/:id` |
| Fichero | `routes.js:47` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Path | `id` |
| Body | — |
| Respuesta | `200 {"ok": true}` |
| Errores | `404 NOT_FOUND`; `400 VALIDATION_ERROR`; 500 `INTERNAL_ERROR` |

`salir(id, uid)` (`service.js:91`):

- Si no existe **o** `doc.uid !== uid` → `404 NOT_FOUND` ("No encontrado").
- Marca `estado: "cancelado"`.
- Si estaba en `avisado` (tenía plaza retenida), **libera la retención** y llama `alLiberarseMesa` para avisar al siguiente.

```bash
curl -X DELETE "$BASE/v1/espera/r_abc_2026-10-15_21:00_u_1" -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true }
```

---

## 19. Reserva en grupo JAM — `/v1/jams`

Router: `src/modules/jams/routes.js`. Servicio: `src/modules/jams/service.js`. Lógica pura: `src/modules/jams/logica.js`. Colección: `jams`.

Modelo: una sala con `codigo` de 6 caracteres (alfabeto sin `0/O/1/I/L`), hasta **4 restaurantes** y **4 franjas** propuestas, y hasta **20 participantes**. Cada participante vota qué restaurantes y qué franjas le valen. Al cerrar (por el anfitrión o al vencer el plazo), `logica.combinaciones` ordena las combinaciones por recuento y se intenta **crear una reserva real** con `reservations/service.crearReserva` a nombre del anfitrión, en orden, hasta que una funcione.

Privacidad: `vistaPublica` **nunca** expone `uid` ni emails; los participantes aparecen con `id` = `sha256(codigo:uid).slice(0,10)`.

Estados de la sala: `abierta` → `reservada` | `sin_mesa`, más `cancelada`.

### 19.1 `POST /v1/jams`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/jams` |
| Fichero | `routes.js:40` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | **`rateLimit(3600000, 10)`** (10 por hora), `validate(crearSchema)` |
| Roles | — |
| Body | `crearSchema` (zod) |
| Respuesta | `201 VistaPublica` |
| Errores | `429 RATE_LIMITED`; `400 VALIDATION_ERROR` (errores acumulados de `validarPropuesta`); 500 `INTERNAL_ERROR` |

Esquema (`routes.js:18`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `cierraEnMin` | `coerce int 5..10080` | Sí |
| `restaurantes` | `{ id: string 1..120 }[]`, min 1, **max 4** | Sí |
| `franjas` | `{ fecha: YYYY-MM-DD, hora: HH:MM }[]`, min 1, **max 4** | Sí |
| `titulo` | `string` máx 80 | No (def. `"Cena en grupo"`) |
| `nombre` | `string` trim 1..40 | No |

`validarPropuesta` añade reglas no cubiertas por el esquema: la franja debe ser futura (`SLOTS` válido) y el cierre debe caer **antes** de la primera franja; título máx 80.

```bash
curl -X POST "$BASE/v1/jams" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"titulo":"Cena del equipo","nombre":"Ana","restaurantes":[{"id":"r_abc"},{"id":"r_def"}],"franjas":[{"fecha":"2026-10-17","hora":"21:00"},{"fecha":"2026-10-17","hora":"21:30"}],"cierraEnMin":180}'
```

```json
{ "codigo": "K7M2QX", "titulo": "Cena del equipo", "anfitrion": "Ana", "estado": "abierta", "cierraEn": "2026-10-09T11:00:00.000Z", "participantes": [], "recuento": { "participantes": 1, "hanVotado": 0, "restaurantes": [ { "id": "r_abc", "votos": 0 }, { "id": "r_def", "votos": 0 } ], "franjas": [ { "indice": 0, "pueden": 2 }, { "indice": 1, "pueden": 2 } ] }, "resultado": null, "miId": "a1b2c3d4e5", "soyAnfitrion": true, "estoyDentro": true }
```

### 19.2 `GET /v1/jams/mias`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/jams/mias` |
| Fichero | `routes.js:49` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Parámetros / Body | — |
| Respuesta | `200 { items: VistaPublica[] }` |
| Errores | 500 `INTERNAL_ERROR` |

`mias(uid)` (`service.js:205`) combina las salas donde el usuario es anfitrión (consulta Firestore) con las que están **solo en memoria** y le incluyen como participante. Máximo 20, orden `creado` descendente.

```bash
curl "$BASE/v1/jams/mias" -H "Authorization: Bearer $TOKEN"
```

### 19.3 `GET /v1/jams/:codigo`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/jams/:codigo` |
| Fichero | `routes.js:58` |
| Auth | `optionalAuth` |
| Roles | — |
| Path | `codigo` |
| Body | — |
| Respuesta | `200 VistaPublica` |
| Errores | 4xx según `err.status`/`err.code` (ver tabla); 500 `INTERNAL_ERROR` |

Ver la sala es **público**: con el código basta (enlace compartible). `obtener(codigo)` además **cierra automáticamente** la sala si el plazo ya venció (`cerrarVencidas` también existe como tarea programada).

Errores de la capa de jams: `CERRADA` (409), `LLENA` (409), `NO_PARTICIPANTE` (403), `FORBIDDEN` (403), `ANFITRION` (409), `VALIDATION_ERROR` (400). El handler `responder` reenvía `err.status` si es `< 500`.

```bash
curl "$BASE/v1/jams/K7M2QX"
```

### 19.4 `GET /v1/jams/:codigo/stream`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/jams/:codigo/stream` |
| Fichero | `routes.js:66` |
| Auth | **Ninguna** |
| Roles | — |
| Path | `codigo` |
| Body | — |
| Respuesta | `200` Server-Sent Events (`text/event-stream`) |
| Cabeceras | `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` |
| Errores | 4xx/5xx en formato JSON **antes** del primer `write`; después, la conexión simplemente se cierra |

Evento SSE `sala` con la `VistaPublica`:

```
event: sala
data: {"codigo":"K7M2QX","estado":"abierta", …}
```

Detalles:

- Envía el estado actual **inmediatamente** al abrir.
- Se suscribe al `EventEmitter` de la sala (`svc.suscribir`).
- Comentario `: ping` cada **25 s** para mantener viva la conexión a través de proxies (Render corta conexiones inactivas).
- En `req.on("close")` limpia el intervalo y cancela la suscripción.
- Esta ruta está **excluida** de las métricas en memoria (`EXCLUIDAS` incluye `/\/stream$/`).

```bash
curl -N "$BASE/v1/jams/K7M2QX/stream"
```

### 19.5 `POST /v1/jams/:codigo/unirse`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/jams/:codigo/unirse` |
| Fichero | `routes.js:83` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | **`rateLimit(60000, 20)`**, `validate(z.object({ nombre }).default({}))` |
| Roles | — |
| Body | `{ nombre?: string trim 1..40 }` |
| Respuesta | `200 VistaPublica` |
| Errores | `429 RATE_LIMITED`; `400 VALIDATION_ERROR`; `409 CERRADA`; `409 LLENA`; 500 `INTERNAL_ERROR` |

`unirse` (`service.js:106`): si el uid ya está en la sala, devuelve la sala sin cambios (idempotente). Si no está `abierta` → `CERRADA` (409). Si ya hay `MAX_PARTICIPANTES` (20) → `LLENA` (409).

Si no se envía `nombre`, se deriva del prefijo del email del token, y si tampoco, `"Invitado"`, recortado a 40.

```bash
curl -X POST "$BASE/v1/jams/K7M2QX/unirse" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"nombre":"Luis"}'
```

### 19.6 `PUT /v1/jams/:codigo/voto`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/jams/:codigo/voto` |
| Fichero | `routes.js:91` |
| Auth | `verifyFirebaseAuth` |
| Middlewares | **`rateLimit(60000, 60)`**, `validate(votarSchema)` |
| Roles | — |
| Body | `{ restaurantes?: string[] máx 4 (def. []), franjas?: int[] 0..3 máx 4 (def. []) }` |
| Respuesta | `200 VistaPublica` |
| Errores | `429 RATE_LIMITED`; `400 VALIDATION_ERROR`; `403 NO_PARTICIPANTE`; `409 CERRADA`; 500 `INTERNAL_ERROR` |

`votar` (`service.js:117`):

- Si la sala no está `abierta` → `409 CERRADA`.
- Si el uid no está en `participantes` → `403 NO_PARTICIPANTE` ("Únete a la sala para votar").
- `restaurantes`: se deduplican y se filtran contra los ids reales de la sala (los ids inventados se descartan en silencio).
- `franjas`: se deduplican y se filtran a enteros en `[0, númeroDeFranjas)`.
- El voto **reemplaza** al anterior (no acumula) y fija `votadoEn`.

```bash
curl -X PUT "$BASE/v1/jams/K7M2QX/voto" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restaurantes":["r_abc"],"franjas":[0,1]}'
```

### 19.7 `POST /v1/jams/:codigo/salir`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/jams/:codigo/salir` |
| Fichero | `routes.js:99` |
| Auth | `verifyFirebaseAuth` |
| Roles | — |
| Path | `codigo` |
| Body | — |
| Respuesta | `200 VistaPublica` |
| Errores | `409 ANFITRION`; 4xx según `err.status`/`err.code`; 500 `INTERNAL_ERROR` |

`salir(codigo, uid)` (`service.js:131`):

- Si el uid es el anfitrión → `409 ANFITRION` ("El anfitrión no puede salir: cancela la sala").
- Si no participa o la sala no está `abierta` → devuelve la sala sin cambios (idempotente).

```bash
curl -X POST "$BASE/v1/jams/K7M2QX/salir" -H "Authorization: Bearer $TOKEN"
```

### 19.8 `POST /v1/jams/:codigo/cerrar`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/jams/:codigo/cerrar` |
| Fichero | `routes.js:107` |
| Auth | `verifyFirebaseAuth` |
| Roles | Solo el **anfitrión** (`anfitrionUid === uid`), comprobado en servicio |
| Path | `codigo` |
| Body | — |
| Respuesta | `200 VistaPublica` |
| Errores | `403 FORBIDDEN` si no es el anfitrión; 500 `INTERNAL_ERROR` |

`cerrar` (`service.js:164` → `cerrarDentro`, `service.js:168`):

1. Si `porUid` no es el anfitrión → `403 FORBIDDEN` ("Solo el anfitrión puede cerrar la votación").
2. Si la sala no está `abierta` → devuelve la sala tal cual (idempotente).
3. Itera `logica.combinaciones(jam)` y llama `crearReserva` a nombre del anfitrión con `comentarios: "Reserva en grupo MIRA «<titulo>» (<n> personas)."` hasta que una tenga éxito.
4. Con éxito → `estado: "reservada"`, `resultado = { …combinacion, reservaId, codigoReserva, intentos, cerradaPor: "anfitrion", cerradaEn }`, y **notifica a todos** por mensaje.
5. Si ninguna combinación funciona → `estado: "sin_mesa"`, `resultado = { intentos: [{ restauranteId, fecha, hora, motivo }], … }` y avisa igualmente.

```bash
curl -X POST "$BASE/v1/jams/K7M2QX/cerrar" -H "Authorization: Bearer $TOKEN"
```

```json
{ "codigo": "K7M2QX", "estado": "reservada", "resultado": { "restauranteId": "r_abc", "fecha": "2026-10-17", "hora": "21:00", "comensales": 2, "reservaId": "Xk2AbC", "codigoReserva": "MIRA-LQ7ZK1", "intentos": 1, "cerradaPor": "anfitrion", "cerradaEn": "2026-10-09T11:05:00.000Z" } }
```

### 19.9 `POST /v1/jams/:codigo/cancelar`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/jams/:codigo/cancelar` |
| Fichero | `routes.js:115` |
| Auth | `verifyFirebaseAuth` |
| Roles | Solo el anfitrión (comprobado en servicio) |
| Path | `codigo` |
| Body | — |
| Respuesta | `200 VistaPublica` |
| Errores | `403 FORBIDDEN`; 500 `INTERNAL_ERROR` |

`cancelar(codigo, uid)` (`service.js:141`) marca la sala como `cancelada` y avisa a los participantes.

```bash
curl -X POST "$BASE/v1/jams/K7M2QX/cancelar" -H "Authorization: Bearer $TOKEN"
```

### 19.10 `PUT /v1/jams/:codigo/foto`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/jams/:codigo/foto` |
| Fichero | `routes.js` |
| Auth | `verifyFirebaseAuth` + `rateLimit(60000, 10)` |
| Roles | Solo el anfitrión (comprobado en servicio) |
| Path | `codigo` |
| Body | `{ tipo: "portada" \| "perfil", dataUrl: string \| null }` |
| Respuesta | `200 VistaPublica` (con `portada` y `foto`) |
| Errores | `400 FOTO_INVALIDA` / `VALIDATION_ERROR`; `403 FORBIDDEN`; `404` |

`ponerFoto(codigo, uid, tipo, dataUrl)` guarda la imagen en `jams/{codigo}.fotos.{portada|perfil}` (sin Firebase Storage, que exige el plan Blaze). El navegador la recorta y comprime antes de enviarla; el servidor solo acepta `data:image/(jpeg|webp|png);base64,…` de hasta 90 000 caracteres (portada) o 30 000 (perfil), por debajo del límite de 100 kB de `express.json()`. `dataUrl: null` quita la foto. La vista pública expone `portada` y `foto` (null si no hay).

```bash
curl -X PUT "$BASE/v1/jams/K7M2QX/foto" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"tipo":"perfil","dataUrl":"data:image/webp;base64,UklGR..."}'
```

---

## 20. Métricas en directo — `/v1/metricas`

Router: `src/modules/metricas/routes.js`. Instrumentación: `src/modules/metricas/metricas.js`.

Solo memoria del proceso: **0 lecturas/escrituras de Firestore**. Se reinicia con el proceso; sirve para mirar la carga "ahora", no como histórico (eso es la Auditoría). Guarda los últimos **300 s** en cubos de 1 s, con muestras acotadas (reservoir de 200 por cubo, 300 por ruta).

### 20.1 `GET /v1/metricas/directo`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/metricas/directo` |
| Fichero | `routes.js:8` |
| Auth | `verifyFirebaseAuth` |
| Roles | `admin` |
| Query | `segundos` (int, def. 300, recortado a `[30, 300]`) |
| Body | — |
| Cabecera | `Cache-Control: no-store` |
| Respuesta | `200 { generadoEn, ventanaS, serie, resumen, rutas, sistema }` |
| Errores | 403 `FORBIDDEN` |

`instantanea(segundos)` (`metricas.js:88`):

| Bloque | Contenido |
|---|---|
| `generadoEn` | ISO-8601 del momento |
| `ventanaS` | Nº de cubos de 1 s devueltos |
| `serie` | `[{ t, rps, e4, e5, p50, p95 }]` por segundo |
| `resumen` | `rpsActual` (media de los últimos 10 s), `peticiones`, `pctErrores`, `errores4xx`, `errores5xx`, `p50`, `p95`, `p99`, `enCurso`, `clientesActivos`, `totalDesdeArranque` |
| `rutas` | Top 12 por volumen: `[{ ruta, n, errores, p95 }]` |
| `sistema` | `memoriaMB`, `heapMB`, `heapTotalMB`, `cpuPct`, `lagMs`, `lagP99Ms`, `carga1m`, `nucleos`, `uptimeS`, `node` |

Notas:

- `clientesActivos` usa un hash `sha1(ip|user-agent)` recortado a 12 caracteres, y purga a los que no se ven hace 60 s.
- `clientes` es un `Map`, así que **solo cuenta actividad del proceso actual**.
- Los identificadores de ruta con más de 12 caracteres alfanuméricos se normalizan a `:id`.

```bash
curl "$BASE/v1/metricas/directo?segundos=60" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "generadoEn": "2026-10-09T08:20:00.000Z",
  "ventanaS": 60,
  "serie": [ { "t": 1788000000000, "rps": 3, "e4": 0, "e5": 0, "p50": 41, "p95": 88 } ],
  "resumen": { "rpsActual": 2.8, "peticiones": 168, "pctErrores": 1.2, "errores4xx": 2, "errores5xx": 0, "p50": 44, "p95": 120, "p99": 210, "enCurso": 3, "clientesActivos": 12, "totalDesdeArranque": 88214 },
  "rutas": [ { "ruta": "GET /v1/restaurants", "n": 640, "errores": 0, "p95": 66 } ],
  "sistema": { "memoriaMB": 148, "heapMB": 72, "heapTotalMB": 96, "cpuPct": 8.4, "lagMs": 0.4, "lagP99Ms": 3.2, "carga1m": 0.42, "nucleos": 2, "uptimeS": 86400, "node": "v20.11.0" }
}
```

---

## 21. Auditoría — `/v1/auditoria`

Router: `src/modules/auditoria/routes.js` (202 líneas, **17 endpoints**).

Historial **append-only** en la colección `auditoria`. Los agregados salen de la copia compartida en memoria de `store.js`, de modo que todos los admins ven exactamente lo mismo.

**Modelo de control de acceso — caso especial:**

- `const soloAdmin = [verifyFirebaseAuth, authorize("admin")]` (`routes.js:18`), aplicado como **spread** (`...soloAdmin`) en los 15 endpoints de lectura/ajustes.
- **Solo** los 2 endpoints de escritura (`POST /` y `POST/batch`) usan `optionalAuth` y son **best-effort**: aceptan eventos de cualquiera, con o sin sesión, y descartan en silencio lo que no valen.

### 21.1 Parámetros comunes de lectura

**Rango temporal** (`rangoDe` → `normalizarPeriodo`, `esquema.js:156`), todo en **UTC**:

| Parámetro | Valores | Default |
|---|---|---|
| `periodo` | `dia` \| `semana` \| `mes` \| `todo` | `mes` |
| `desde` | fecha ISO — **gana sobre `periodo`** | — |
| `hasta` | fecha ISO. Si es `YYYY-MM-DD` a medianoche, se extiende 1 día | — |
| `granularidad` | `hora` \| `dia` \| `semana` \| `mes` | según periodo: `dia`→`hora`, `semana`/`mes`→`dia`, `todo`→`mes` |

Semántica: `dia` = hoy UTC por horas; `semana` = semana ISO actual (lunes 00:00 UTC) por días; `mes` = mes actual por días; `todo` = desde 1970 por meses. Con `periodo: "todo"` y sin `desde`, además se calcula el periodo `anterior` de igual longitud para los deltas del overview.

**Filtros** (`filtrosDe`, `routes.js:38`): `fuente`, `tipos`, `categoria`, `origen`, `resultado`, `actorUid`, `actorTipo`, `entidadId`, `dispositivo`, `buscar`. Cada valor se recorta a 200 caracteres.

**Cabecera común de respuesta** (`meta`, `routes.js:48`): `version` (versión del esquema, hoy `1`), `revision`, `periodo`, `desde`, `hasta`, `granularidad`, `generadoEn`.

Todos los agregados pasan por `store.cacheado(clave, calcular)`: se cachean por clave (parámetros ordenados alfabéticamente) y se invalidan al cambiar la copia en memoria o pasado `CACHE_MS`; máximo 300 entradas.

### 21.2 `POST /v1/auditoria`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/auditoria` |
| Fichero | `routes.js:22` |
| Auth | **`optionalAuth`** |
| Middlewares | **`rateLimit(60000, 240)`**, `optionalAuth` |
| Roles | — (cualquiera) |
| Body | Un **evento suelto** con el esquema de `esquema.js:30` |
| Respuesta | `202 { aceptados, descartados, motivos }` |
| Errores | 429 `RATE_LIMITED`; 500 `INTERNAL_ERROR` |

Nota: el body **no** se valida con zod en la ruta; `svc.insertarReales` valida cada evento con `validarEvento` y lo descarta con un motivo.

`insertarReales` (`service.js:90`) devuelve `202` **aunque lo descarte todo**. Motivos de descarte:

| Motivo | Condición |
|---|---|
| `registro_desactivado` | `ajustes.registroActivo === false` |
| `bot` | User-Agent vacío o que casa con `BOT_UA` (bot, crawl, spider, curl, wget, python-requests, axios/…) |
| `ip_propia` | IP en `AUDITORIA_IPS_PROPIAS` |
| `trafico_propio` | Admin y `ajustes.excluirPropio` y la categoría es `navegacion`/`busqueda`/`catalogo` |
| `throttle` | Más de un `scroll_profundidad` por sesión cada 2 s |
| `panel_sin_admin` | `origen: "panel"` sin rol `admin` |
| `cuota` | Se superó `AUDITORIA_MAX_DIA` (8000) |
| `invalido` | No pasa `eventoSchema` (p. ej. `tipo` fuera del catálogo) |
| `duracion` | `meta.duracionMs < 50` (dobles clics, renders) |

Datos que fija el **servidor**, nunca el cliente: `fuente: "real"`, `actorUid`, `actorEmail`, `actorTipo` (`admin`/`empresa`/`usuario`), `dispositivo.pais` (de `cf-ipcountry` o `x-vercel-ip-country`), `dispositivo.ipHash` (`sha256(salt:ip)` recortado a 16), y `ts` real del servidor (el `ts` del cliente solo se acepta si no es futuro y no es más de 2 min antiguo; si no, se guarda en `tsCliente`).

`datos` y `cambios` se sanean (`limpiarDatos` / `limpiarCambios`): máximo 15 claves, texto a 512 caracteres, sin claves PII (`email`, `telefono`, `token`, `tarjeta`, `dni`…) y valores que parecen email o número de tarjeta se sustituyen por `"[oculto]"`.

El `tipo` debe estar en el catálogo (`catalogo.js`): categorías `auth`, `navegacion`, `busqueda`, `catalogo`, `reservas`, `negocio`, `puntos`, `admin`.

```bash
curl -X POST "$BASE/v1/auditoria" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"tipo":"pagina_vista","origen":"app","pagina":"/catalogo","ruta":"/catalogo","sesionId":"s_1","dispositivo":{"tipo":"mobile","os":"iOS","navegador":"Safari"},"meta":{"duracionMs":120}}'
```

```json
{ "aceptados": 1, "descartados": 0, "motivos": {} }
```

### 21.3 `POST /v1/auditoria/batch`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/auditoria/batch` |
| Fichero | `routes.js:27` |
| Auth | **`optionalAuth`** |
| Middlewares | **`rateLimit(60000, 120)`**, `optionalAuth`, `validate(batchSchema)` |
| Roles | — |
| Body | `{ eventos: any[] }` — min 1, **max 100** (`MAX_BATCH`) |
| Respuesta | `202 { aceptados, descartados, motivos }` |
| Errores | `400 VALIDATION_ERROR`; `429 RATE_LIMITED`; 500 `INTERNAL_ERROR` |

Aplica exactamente las mismas reglas de descarte que 21.2 pero a un lote, y conserva el **orden** de los eventos gracias al `ts` del cliente (aceptado si no es futuro ni más de 2 min antiguo).

```bash
curl -X POST "$BASE/v1/auditoria/batch" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"eventos":[{"tipo":"pagina_vista","pagina":"/","sesionId":"s_1"},{"tipo":"reserva_creada","entidadId":"Xk2AbC","sesionId":"s_1"}]}'
```

### 21.4 `GET /v1/auditoria/overview`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/overview` |
| Fichero | `routes.js:61` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | Periodo + filtros |
| Body | — |
| Respuesta | `200 { …meta, kpis, deltas, porTipo, porOrigen, porFuente }` |
| Errores | 401, 403 `FORBIDDEN`, 500 `INTERNAL_ERROR` |

`overview` (`agregados.js:81`):

- `kpis` — `kpis(actual)` sobre el rango filtrado.
- `deltas` — variación en % frente al periodo `anterior`. **Null** si no hay base de comparación (o si el previo era 0 y el actual no, porque no hay un % honesto).
- `porTipo` — top 8.
- `porOrigen` — top 10.
- `porFuente` — `{ real, sim }` calculado **sin filtrar por `fuente`**, para que la leyenda real/simulado sea honesta.

```bash
curl "$BASE/v1/auditoria/overview?periodo=semana" -H "Authorization: Bearer $TOKEN"
```

```json
{ "version": 1, "revision": 4, "periodo": "semana", "desde": "2026-10-05T00:00:00.000Z", "hasta": "2026-10-09T08:30:00.000Z", "granularidad": "dia", "generadoEn": "2026-10-09T08:30:00.000Z", "kpis": { "eventos": 18422, "errores": 213, "sesiones": 9040, "usuarios": 3120 }, "deltas": { "eventos": 12.4, "errores": -3.1, "sesiones": 8.2, "usuarios": 5.6 }, "porTipo": [], "porOrigen": [], "porFuente": { "real": 17000, "sim": 1422 } }
```

### 21.5 `GET /v1/auditoria/series`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/series` |
| Fichero | `routes.js:67` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | Periodo + filtros + `metrica` (def. `"eventos"`) |
| Body | — |
| Respuesta | `200 { …meta, metrica, granularidad, puntos }` |
| Errores | 401, 403, 500 |

`series` (`agregados.js:104`): `puntos` es una serie por cubo temporal (según `granularidad`), con los **huecos a 0** para que no se unan puntos en la gráfica.

Cada punto: `{ clave, eventos, real, sim, errores, sesiones, usuarios }`, con `clave` en formato `YYYY-MM-DDTHH:00`, `YYYY-MM-DD`, `YYYY-Www` o `YYYY-MM`. Máximo 2000 cubos.

```bash
curl "$BASE/v1/auditoria/series?periodo=dia&metrica=eventos" -H "Authorization: Bearer $TOKEN"
```

```json
{ "metrica": "eventos", "granularidad": "hora", "puntos": [ { "clave": "2026-10-09T08:00", "eventos": 412, "real": 400, "sim": 12, "errores": 3, "sesiones": 180, "usuarios": 140 } ] }
```

### 21.6 `GET /v1/auditoria/breakdown`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/breakdown` |
| Fichero | `routes.js:73` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | `dimension`, `top` (1..50, def. 10), periodo + filtros |
| Body | — |
| Respuesta | `200 { …meta, dimension, items }` |
| Errores | 401, 403, 500 |

`dimension` válida (`agregados.js:8`, `DIMENSIONES`): `tipo`, `origen`, `fuente`, `actorTipo`, `dispositivo.tipo`, `dispositivo.os` y las restantes del catálogo. Si no es válida, cae a `"tipo"`. `top` se recorta a `[1, 50]`.

```bash
curl "$BASE/v1/auditoria/breakdown?dimension=actorTipo&top=5&periodo=mes" -H "Authorization: Bearer $TOKEN"
```

```json
{ "dimension": "actorTipo", "items": [ { "valor": "usuario", "n": 15200 }, { "valor": "empresa", "n": 410 }, { "valor": "admin", "n": 88 } ] }
```

### 21.7 `GET /v1/auditoria/actividad`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/actividad` |
| Fichero | `routes.js:83` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | Periodo + filtros |
| Body | — |
| Respuesta | `200 { …meta, calor, funnels }` |
| Errores | 401, 403, 500 |

Extra de la sub-pestaña Actividad:

- `calor` — matriz `7 × 24` (día de la semana × hora, **UTC**) con el conteo de eventos.
- `funnels` — embudos calculados **por sesión** (`sesionId || anonId || actorUid`): una sesión cuenta en un paso solo si llegó a él y a todos los anteriores. Dos embudos definidos (`FUNNELS`, `agregados.js:138`):
  - `registro`: `pagina_vista → registro_iniciado → registro_completado → login_exitoso`
  - `reserva`: `busqueda → restaurante_visto → reserva_iniciada → reserva_creada → reserva_completada`

```bash
curl "$BASE/v1/auditoria/actividad?periodo=semana" -H "Authorization: Bearer $TOKEN"
```

### 21.8 `GET /v1/auditoria/usuarios`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/usuarios` |
| Fichero | `routes.js:92` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | Periodo + filtros |
| Body | — |
| Respuesta | `200 { …meta, items }` |
| Errores | 401, 403, 500 |

`usuarios` (`agregados.js:163`): agrega por `actorUid` con `eventos`, primera/última actividad, último login (eventos `login_exitoso` o `login_google`), y último dispositivo conocido. **Trunca a 500** con `.slice(0, 500)`.

```bash
curl "$BASE/v1/auditoria/usuarios?periodo=mes" -H "Authorization: Bearer $TOKEN"
```

### 21.9 `GET /v1/auditoria/logs`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/logs` |
| Fichero | `routes.js:99` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | Periodo + filtros + `limite` (1..500, def. 50), `cursor` |
| Body | — |
| Respuesta | `200 { …meta, total, items, cursor }` |
| Errores | 401, 403, 500 |

A diferencia del resto, **no** pasa por `store.cacheado`: siempre recalcula sobre `store.todos()`. `paginar` (`agregados.js:178`) ordena por `ts` descendente (desempate por `id`), pagina por cursor y devuelve el `cursor` siguiente (id del último elemento) o `null` al final.

```bash
curl "$BASE/v1/auditoria/logs?periodo=dia&limite=100" -H "Authorization: Bearer $TOKEN"
```

```json
{ "total": 1842, "items": [], "cursor": "ev_000123" }
```

### 21.10 `GET /v1/auditoria/usuario/:uid`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/usuario/:uid` |
| Fichero | `routes.js:120` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Path | `uid` |
| Query | `entidadId` (opcional) |
| Body | — |
| Respuesta | `200 { uid, entidadId, total, items }` |
| Errores | `400 VALIDATION_ERROR` si no hay `uid` ni `entidadId`; 403; 500 |

Timeline de un usuario (`timeline`, `routes.js:106`), máximo 1000 eventos, orden `ts` descendente. Incluye:

- Eventos con `actorUid === uid`.
- Eventos donde `entidadTipo === "usuario"` y `entidadId === uid`.
- Eventos **sin** `actorUid` pero con el mismo `anonId` (lo que hizo ese navegador antes de identificarse).
- Si además llega `entidadId`, cualquier evento con esa entidad.

```bash
curl "$BASE/v1/auditoria/usuario/u_1?periodo=todo" -H "Authorization: Bearer $TOKEN"
```

### 21.11 `GET /v1/auditoria/usuario`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/usuario` |
| Fichero | `routes.js:121` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | `entidadId` (o el `uid` de la variante con path) |
| Body | — |
| Respuesta | `200 { uid: null, entidadId, total, items }` |
| Errores | `400 VALIDATION_ERROR` ("uid o entidadId requerido"); 403; 500 |

Mismo handler `timeline`, sin `uid` en la ruta: obliga a pasar `?entidadId=`. Con `?entidadId=` **no** hay búsqueda por `anonId`.

```bash
curl "$BASE/v1/auditoria/usuario?entidadId=Xk2AbC" -H "Authorization: Bearer $TOKEN"
```

### 21.12 `GET /v1/auditoria/export`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/export` |
| Fichero | `routes.js:135` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | `formato` (`json` \| `csv`, def. `csv`), `estimar` (`"1"`), periodo + filtros |
| Body | — |
| Respuesta | Fichero descargable (CSV o JSON) |
| Cabeceras | `Content-Disposition: attachment; filename="auditoria_<periodo>_<YYYY-MM-DD>.<ext>"` |
| Errores | 403; 500 |

Con `estimar=1` devuelve en JSON, **sin generar el fichero** ni registrar auditoría:

```json
{ "eventos": 18422, "bytesAprox": 5895040 }
```

(`bytesAprox = eventos × 320` para CSV, `× 700` para JSON.)

Sin `estimar`, se **registra un evento `export_auditoria`** en la propia auditoría (`origen: "panel"`) con los filtros usados, y luego responde:

- `formato=json`: `application/json` con `{ …meta, filtros, total, eventos }`.
- `formato=csv` (def.): `text/csv; charset=utf-8`, separador **`;`**, con **BOM UTF-8** al inicio y 25 columnas:

```
ts, tipo, fuente, origen, resultado, actorTipo, actorUid, actorNombre, entidadTipo, entidadId, entidadNombre, pagina, ruta, accion, sesionId, dispositivo.tipo, dispositivo.os, dispositivo.navegador, pais, codigoError, cambios, datos, simRunId
```

`celda` entrecomilla y escapa cualquier valor que contenga `;`, `"` o salto de línea. La columna `pais` se lee de `dispositivo.pais`.

```bash
curl -OJ "$BASE/v1/auditoria/export?periodo=mes&formato=csv" -H "Authorization: Bearer $TOKEN"

# Estimar antes de descargar
curl "$BASE/v1/auditoria/export?periodo=todo&estimar=1" -H "Authorization: Bearer $TOKEN"
```

### 21.13 `GET /v1/auditoria/estado`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/estado` |
| Fichero | `routes.js:160` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { versionEsquema, revision, ajustes, simRunId, sim, contadores, ultimoBackup, totales }` |
| Errores | 403; 500 |

Lee el estado con `{ fresco: true }` (salta la caché de 30 s) y añade `totales = { eventos, real, sim }` calculados sobre `store.todos()`.

`ajustes` por defecto: `{ registroActivo: true, excluirPropio: false }`.

```bash
curl "$BASE/v1/auditoria/estado" -H "Authorization: Bearer $TOKEN"
```

```json
{ "versionEsquema": 1, "revision": 4, "ajustes": { "registroActivo": true, "excluirPropio": false }, "simRunId": null, "sim": null, "contadores": {}, "ultimoBackup": null, "totales": { "eventos": 120450, "real": 118900, "sim": 1550 } }
```

### 21.14 `PUT /v1/auditoria/ajustes`

| Campo | Valor |
|---|---|
| Método / Ruta | `PUT /v1/auditoria/ajustes` |
| Fichero | `routes.js:167` |
| Auth | `...soloAdmin` |
| Middlewares | `validate(ajustesSchema)` |
| Roles | `admin` |
| Body | `{ registroActivo?: boolean, excluirPropio?: boolean }` |
| Respuesta | `200 { ajustes }` |
| Errores | `400 VALIDATION_ERROR`; 403; 500 |

Hace merge con los ajustes actuales. Si algún valor cambia realmente, registra un evento `ajustes_cambiados` **con `forzar: true`** (se registra aunque `registroActivo` esté apagado: apagarlo también es una acción auditable), con `cambios: [{ campo, antes, despues }]`.

```bash
curl -X PUT "$BASE/v1/auditoria/ajustes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"excluirPropio":true}'
```

```json
{ "ajustes": { "registroActivo": true, "excluirPropio": true } }
```

### 21.15 `GET /v1/auditoria/sim/estado`

| Campo | Valor |
|---|---|
| Método / Ruta | `GET /v1/auditoria/sim/estado` |
| Fichero | `routes.js:179` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Parámetros / Body | — |
| Respuesta | `200 { simRunId, sim, enCurso }` |
| Errores | 403; 500 |

`sim` es `{ simRunId, estado: "en_curso"|"completada"|"error"|"limpiada", escritos, total, inicio, fin, resumen, mensaje? }`. `enCurso` es el `simRunId` de una simulación corriendo **en esta instancia**.

```bash
curl "$BASE/v1/auditoria/sim/estado" -H "Authorization: Bearer $TOKEN"
```

```json
{ "simRunId": null, "sim": null, "enCurso": null }
```

### 21.16 `POST /v1/auditoria/sim/run`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/auditoria/sim/run` |
| Fichero | `routes.js:184` |
| Auth | `...soloAdmin` |
| Middlewares | `validate(z.object({...}).default({}))` |
| Roles | `admin` |
| Body | `{ usuarios?: int 1..500, dias?: int 1..365 }` |
| Respuesta | `202 { simRunId, total, resumen }` |
| Errores | `400 VALIDATION_ERROR`; 403; 500 |

`simular` (`service.js:174`) genera los eventos **de una vez** y escribe en lotes de fondo (sin bloquear la respuesta). Si ya hay una simulación en curso en esta instancia, devuelve `{ enCurso: true, simRunId }`.

Id del run: `sim-<YYYYMMDDHHMMSS>-<4 hex>`.

```bash
curl -X POST "$BASE/v1/auditoria/sim/run" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"usuarios":100,"dias":30}'
```

```json
{ "simRunId": "sim-20261009083000-a1b2", "total": 18420, "resumen": { "sesiones": 3120 } }
```

### 21.17 `POST /v1/auditoria/sim/reset`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/auditoria/sim/reset` |
| Fichero | `routes.js:189` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Body | `{ simRunId?: string \| null }` (opcional) |
| Respuesta | `200 { borrados }` |
| Errores | 403; 500 |

`limpiarSimulacion(simRunId)` (`service.js:202`) borra **solo** documentos con `fuente: "sim"` (del run indicado, o de todos si se omite), en lotes de 500. **Nunca toca los eventos reales.** Sube la `revision` del estado.

```bash
curl -X POST "$BASE/v1/auditoria/sim/reset" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"simRunId":"sim-20261009083000-a1b2"}'
```

```json
{ "borrados": 18420 }
```

### 21.18 `POST /v1/auditoria/purge`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/auditoria/purge` |
| Fichero | `routes.js:194` |
| Auth | `...soloAdmin` |
| Roles | `admin` |
| Query | `anios` (número ≥ 1) |
| Body | `{ confirmacion: "PURGAR" }` |
| Respuesta | `200 { borrados, limite }` |
| Errores | `400 VALIDATION_ERROR` (`"anios >= 1 requerido"`), `400 CONFIRMACION_REQUERIDA`, 403, 500 |

Doble guardarraíl: `anios >= 1` y confirmación literal.

`purgar(anios)` (`service.js:218`) borra los eventos con `ts` anterior a `hoy − anios×365 días`, en lotes de 500, y sube la `revision`.

```bash
curl -X POST "$BASE/v1/auditoria/purge?anios=2" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"confirmacion":"PURGAR"}'
```

```json
{ "borrados": 84200, "limite": "2024-10-09T08:35:00.000Z" }
```

---

## 22. Agente IA — `/v1/ai`

Router: `src/modules/ai/routes.js`. Ficheros: `schemas.js`, `service.js`, `agentLoop.js`, `tools.js`, `confirmStore.js`, `systemPrompt.js`, `provider/`.

### 22.1 `POST /v1/ai/agent`

| Campo | Valor |
|---|---|
| Método / Ruta | `POST /v1/ai/agent` |
| Fichero | `routes.js:10` |
| Auth | `optionalAuth` (funciona sin sesión, con menos herramientas) |
| Middlewares | **`rateLimit(60000, 10)`** (10/min), `validate(agentSchema)`, **`idempotency`** |
| Roles | Depende de la herramienta: cada tool declara sus `roles` (`public`, `cliente`, `empresa`, `admin`) |
| Body | `agentSchema` (zod) |
| Cabecera de respuesta | `X-Prompt-Hash` (hash del system prompt, si el service lo devuelve) |
| Respuesta | `200 { reply, actions, provider, model, needsConfirm?, retryable? }` |
| Errores | `429 RATE_LIMITED`; `400 VALIDATION_ERROR`; 500 `INTERNAL_ERROR` |

Esquema (`schemas.js:3`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `message` | `string` trim 1..2000 (`"message no puede estar vacío"`) | Sí |
| `history` | `{ role: "user"\|"model", content: string 1..4000 }[]`, **máx 10** | No (def. `[]`) |
| `confirmId` | `string` **UUID** | No |

Respuesta:

| Campo | Significado |
|---|---|
| `reply` | Texto en español generado por el modelo |
| `actions` | `[{ tool, args, result }]` — una entrada por tool llamada |
| `provider` | `provider.name` (p. ej. `"gemini"`) |
| `model` | Modelo que respondió (`null` si no hubo llamada al modelo) |
| `needsConfirm` | `{ confirmId, summary, payload: { tool, args } }` — **solo si hay una operación mutante pendiente** |
| `retryable` | `true` solo si el proveedor no está disponible o el loop falló |

El handler construye el payload **incluyendo solo las claves con valor** (`if (out.needsConfirm)`, `if (out.retryable === true)`) porque el middleware de idempotencia cachea el body y Firestore rechaza `undefined`.

### 22.2 Catálogo de herramientas del agente

Definidas en `src/modules/ai/tools.js` (**60 tools**). Control de acceso (`checkAccess`, `tools.js:835`):

| Situación | Resultado |
|---|---|
| Tool con `roles` que incluye `"public"` | Accesible sin sesión |
| Sin `req.user` | Solo las de rol `cliente` se le ofrecen (`toolsForRole`) y el acceso da `MISSING_TOKEN` |
| Rol no en `tool.roles` | `FORBIDDEN` |

Los errores de tool se mapean con `mapToolError` a códigos cerrados: `MISSING_TOKEN`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`, `INSUFFICIENT`, `RATE_LIMITED`, `WHEEL_LOCKED`, `SELF_INVITE`, `NOT_IMPLEMENTED`, `INTERNAL_ERROR` (si no encaja en ninguno).

Herramientas **mutantes** (las que requieren confirmación en 2 pasos):

```
createReservation, cancelReservation, redeemPoints, dailyLogin, spinWheel,
createReview, likeReview, unlikeReview, createInvite, acceptInvite, updateMe,
markRead, createContacto, createNegocio, trackInteraction, completeReservation,
reservationTicket, updateRestaurant, updateReservationStatus, confirmAttendance,
markNoShow, createPromotion, addManualPoints, setRacha, deltaRacha, unclaimToday,
approveNegocio, rejectNegocio, resolveContacto
```

Herramientas de **solo lectura**: `searchRestaurants`, `getRestaurant`, `countRestaurants`, `checkAvailability`, `listPromotions`, `listReviews`, `getUserReviews`, `listMyReservations`, `getBalance`, `getLedger`, `inviteMy`, `listTickets`, `getTicket`, `getMe`, `listMensajes`, `unreadCount`, `listMine`, `listMyNegocios`, `myRestaurants`, `myRestaurant`, `dashboardTicket`, `promoStats`, `listAllUsers`, `adminOverview`, `opsOverview`, `adminReservations`, `dashboardUsers`, `revenue`, `fraudFlags`, `pendingNegocios`, `pendingContactos`.

### 22.3 Flujo de confirmación en 2 pasos — caso especial

Es el mecanismo central del agente. Una tool con `mutating: true` **nunca** se ejecuta en el turno en que el modelo la pide.

**Paso 1 — el modelo pide la operación.**

`runAgentLoop` (`agentLoop.js:247`) intercepta la llamada:

1. Si ya hay una operación pendiente → devuelve `{ ok: false, error: "AWAITING_CONFIRM", message: "Ya hay una operación pendiente de confirmación." }` y **no** crea otra.
2. Construye el `summary` con `tool.summarize(args)` si existe, si no `` `${tool.name}: ${truncate(args)}` ``.
3. Llama `onPending`, que en el service es `createConfirm({ uid, role, tool, args, summary })` (`confirmStore.js:7`): genera un `crypto.randomUUID()` y lo guarda en la colección **`aiConfirms`** con `{ uid, role, tool, args, summary, createdAt, expiresAt }`, donde `expiresAt = ahora + 10 min` (`TTL_MS`).
4. Si falla la preparación → `{ ok: false, error: "CONFIRM_FAILED", … }`.
5. Marca la tool como `pending` y **fuerza una última pasada** del modelo (`forceFinal`) para que redacte la respuesta pidiendo la confirmación al usuario.

Respuesta:

```json
{
  "reply": "Voy a cancelar tu reserva del 15 de octubre a las 21:00 en Green Bowl (4 personas). ¿Me confirmas?",
  "actions": [
    { "tool": "cancelReservation", "args": { "id": "Xk2AbC" }, "result": { "pending": true, "confirmId": "b1f2c3d4-…-9a8b" } }
  ],
  "needsConfirm": {
    "confirmId": "b1f2c3d4-…-9a8b",
    "summary": "Cancelar la reserva MIRA-LQ7ZK1",
    "payload": { "tool": "cancelReservation", "args": { "id": "Xk2AbC" } }
  },
  "provider": "gemini",
  "model": "gemini-3.5-flash-lite"
}
```

**Paso 2 — el usuario confirma.**

Se reenvía al **mismo endpoint** con `confirmId`:

```bash
curl -X POST "$BASE/v1/ai/agent" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Sí, cancelledalo","confirmId":"b1f2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"}'
```

`runAgent` detecta el `confirmId` y **corta el loop**: no llama al agente, ejecuta directamente (`service.js:36` `runConfirmed`):

1. **Sin sesión** → responde `200` con `reply: "Necesitas iniciar sesión para confirmar la operación."`, `actions: []` y sin ejecutar nada.
2. **`takeConfirm(confirmId, user)`** (`confirmStore.js:21`), que es un **get-and-delete atómico en la práctica**:
   - No existe → `null`.
   - `data.uid !== user.uid` → `null` (un `confirmId` ajeno no se puede usar).
   - Caducado (`expiresAt < ahora`) → lo borra y devuelve `null`.
   - Válido → **lo borra** y devuelve los datos. **Es de un solo uso**: reenviar el mismo `confirmId` no vuelve a ejecutar nada.
3. Con `stored === null` → `reply: "La confirmación no es válida, ya fue usada o ha caducado. Vuelve a iniciar la operación."`, `actions: []`.
4. Comprueba que la tool siga habilitada (`getTool` + `isEnabled`); si no → `"Esa operación ya no está disponible."`.
5. Ejecuta `executeTool(tool, stored.args, user)` → `actions = [{ tool, args, result }]`.
6. Si `result.ok`, hace una **sola** llamada de redacción al modelo con un timeout de **8 s** (`PHRASE_TIMEOUT_MS`) para que narre el resultado en 2 frases. Si esa llamada falla o no devuelve texto, cae a un texto fijo: `"Operación completada: <summary>."` o `result.message` / `"No se pudo completar la operación."`.

Respuesta:

```json
{
  "reply": "He cancelado la reserva MIRA-LQ7ZK1. La plaza queda libre para la lista de espera.",
  "actions": [ { "tool": "cancelReservation", "args": { "id": "Xk2AbC" }, "result": { "ok": true, "data": { "estado": "cancelada" } } } ],
  "provider": "gemini",
  "model": "gemini-3.5-flash-lite"
}
```

Garantías del diseño:

- `needsConfirm` **nunca** viaja en la respuesta de confirmación.
- Un `confirmId` pertenece a un solo `uid` y caduca a los 10 minutos.
- Solo hay una operación pendiente a la vez.
- Todos los logs del agente incluyen `promptHash` y `requestId` (`X-Request-Id` de la petición).

### 22.4 Cuando el proveedor no está disponible

Si `getProvider(env.AI_PROVIDER)` lanza, el service **no** falla: responde `200` con

```json
{ "reply": "El asistente no está disponible ahora mismo. Inténtalo de nuevo en unos segundos.", "actions": [], "provider": "gemini", "model": null, "retryable": true }
```

y registra `ai.provider.missing` con nivel `error`.

```bash
# Consulta simple
curl -X POST "$BASE/v1/ai/agent" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"¿Qué restaurantes veganos hay cerca de Ruzafa?"}'

# Con historial (máx 10 turnos)
curl -X POST "$BASE/v1/ai/agent" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"¿Y el precio medio?","history":[{"role":"user","content":"Dime restaurantes veganos en Ruzafa"},{"role":"model","content":"Hay 3 opciones: Green Bowl, Raíz y Huerta."}]}'
```

---

## 22 bis. Ofertas por distancia — `/v1/ofertas` (G02)

Router: `src/modules/ofertas/routes.js`. Servicio: `service.js`. Reglas puras: `logica.js`. Colección: `ofertas` (solo vía API; reglas de Firestore cerradas). Contrato de la fase 1 en la bóveda del equipo, `Proyecto/Contratos API.md`.

**Modelo:** `{ id, restauranteId, titulo (1-80), activa, desde, hasta (AAAA-MM-DD o null, incluidos), niveles, creado, actualizado }`. `niveles` son siempre 4, en el orden fijo de distancias **1000, 500, 100 y 20 m**, cada uno `{ distancia, texto (1-140), descuentoPct (entero 0-100) }`. El descuento no puede bajar al acercarse y el de 20 m (la llegada) tiene que ser mayor que el de 1000 m. `desde` ≤ `hasta`. Esquemas `strict`: un campo desconocido da 400. **Una sola oferta activa por restaurante** (409 `CONFLICT`). La oferta no guarda nada del usuario ni de su ubicación.

| Método / Ruta | Auth | Respuesta | Errores |
|---|---|---|---|
| `GET /v1/ofertas?restauranteId=` | pública | `200 { data: [Oferta] }` solo la activa y vigente hoy (Europe/Madrid) | 400 |
| `GET /v1/ofertas/cerca?lat=&lng=` (G05) | pública + `rateLimit(60000, 60)` | `200 { data: [{ restaurante: { id, nombre, coordenadas: { lat, lng } }, oferta, distanciaM, nivel }] }`: ofertas activas y vigentes a ≤ 1000 m, de la más cercana a la más lejana; `nivel` = el de menor distancia con `distanciaM <= distancia` | 400, 429 |
| `GET /v1/ofertas/mias?restauranteId=` | empresa dueña o admin | `200 { data: [Oferta] }` todas, de la más nueva a la más antigua | 400, 401, 403, 404 |
| `POST /v1/ofertas` | empresa dueña o admin + `rateLimit(60000, 30)` | `201 Oferta` | 400, 401, 403, 404 (restaurante), 409 |
| `PUT /v1/ofertas/:id` | empresa dueña o admin + `rateLimit(60000, 30)` | `200 Oferta` (sustituye título, activa, vigencia y niveles; `restauranteId` no se acepta) | 400, 401, 403, 404, 409 |
| `DELETE /v1/ofertas/:id` | empresa dueña o admin | `204` | 401, 403, 404 |

El dueño se comprueba con `comprobarRestaurante` (uid/ownerUid del restaurante, `restaurantId(s)` del perfil o email del token). La consulta por restaurante es de igualdad simple y se ordena en memoria, así que no requiere índice compuesto. «Una activa» se garantiza con un documento de bloqueo `ofertas_activas/{restauranteId}` = `{ ofertaId }`, leído y escrito en la misma transacción que la oferta en crear, editar y borrar. Firestore serializa las transacciones que tocan ese documento, así que de dos altas o activaciones simultáneas una se confirma y la otra recibe 409. Desactivar o borrar la activa libera el bloqueo; un bloqueo que apunta a una oferta borrada o inactiva no impide activar otra.

**`/cerca`:** la posición no se guarda ni se registra (los logs guardan la ruta sin la query). Candidatos = ofertas apuntadas por `ofertas_activas` con las coordenadas de su restaurante (`coordenadas.latitud/longitud`), cacheados 60 s en memoria; crear, editar o borrar en la misma instancia invalidan la caché (con generación: una carga empezada antes de invalidar no publica su resultado) y las peticiones simultáneas comparten la carga en curso. Coste por recarga: 1 consulta de `ofertas_activas` (N documentos) + 2N lecturas (oferta y restaurante), unas 3N lecturas cada 60 s por instancia con tráfico. Restaurantes sin coordenadas no aparecen. Distancia con haversine: radio, nivel y orden usan la distancia real; `distanciaM` es solo el valor redondeado que se muestra (a 1000,4 m no aparece aunque redondee a 1000).

```bash
curl "$BASE/v1/ofertas/cerca?lat=41.3874&lng=2.1686"
curl "$BASE/v1/ofertas?restauranteId=abc123"
curl -X POST "$BASE/v1/ofertas" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"restauranteId":"abc123","titulo":"Menú de mediodía","activa":true,"niveles":[{"distancia":1000,"texto":"Café gratis","descuentoPct":5},{"distancia":500,"texto":"10 %","descuentoPct":10},{"distancia":100,"texto":"15 %","descuentoPct":15},{"distancia":20,"texto":"20 % + postre","descuentoPct":20}]}'
```

---

## 23. Resumen de los 105 endpoints

### 23.1 Salud (no cuenta en los 105 de negocio)

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| H1 | `GET` | `/health` | — | — |

### 23.2 Catálogo de restaurantes — 7

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 1 | `GET` | `/v1/restaurants` | `optionalAuth` | — |
| 2 | `GET` | `/v1/restaurants/count` | `optionalAuth` | — |
| 3 | `GET` | `/v1/restaurants/mapa` | `optionalAuth` | — |
| 4 | `GET` | `/v1/restaurants/:id/foto` | — | — |
| 5 | `GET` | `/v1/restaurants/cache/stats` | `optionalAuth` | — |
| 6 | `GET` | `/v1/restaurants/:id` | `optionalAuth` | — |
| 7 | `PUT` | `/v1/restaurants/:id` | `verifyFirebaseAuth` | — |

### 23.3 Reservas — 6

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 8 | `GET` | `/v1/reservations/availability` | `optionalAuth` | — |
| 9 | `POST` | `/v1/reservations` | `verifyFirebaseAuth` | — |
| 10 | `GET` | `/v1/reservations` | `verifyFirebaseAuth` | — |
| 11 | `PUT` | `/v1/reservations/:id/cancel` | `verifyFirebaseAuth` | dueño o `admin` |
| 12 | `PUT` | `/v1/reservations/:id/complete` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 13 | `POST` | `/v1/reservations/:id/ticket` | `verifyFirebaseAuth` | `empresa`, `admin` |

### 23.4 Puntos — 10

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 14 | `GET` | `/v1/points/balance` | `verifyFirebaseAuth` | — |
| 15 | `GET` | `/v1/points/is-new-user` | `verifyFirebaseAuth` | — |
| 16 | `GET` | `/v1/points/ledger` | `verifyFirebaseAuth` | — |
| 17 | `POST` | `/v1/points/redeem` | `verifyFirebaseAuth` | — |
| 18 | `POST` | `/v1/points/daily-login` | `verifyFirebaseAuth` | — |
| 19 | `GET` | `/v1/points/wheel/prizes` | `verifyFirebaseAuth` | — |
| 20 | `POST` | `/v1/points/wheel` | `verifyFirebaseAuth` | `admin` solo para `force=1` en dev |
| 21 | `GET` | `/v1/points/discounts` | `verifyFirebaseAuth` | — |
| 22 | `POST` | `/v1/points/discount/claim` | `verifyFirebaseAuth` | — |
| 23 | `POST` | `/v1/points/review` | `verifyFirebaseAuth` | — |

### 23.5 Usuarios — 4

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 24 | `GET` | `/v1/users/me` | `verifyFirebaseAuth` | — |
| 25 | `PUT` | `/v1/users/me` | `verifyFirebaseAuth` | — |
| 26 | `GET` | `/v1/users/me/is-admin` | `verifyFirebaseAuth` | — |
| 27 | `GET` | `/v1/users/all` | `verifyFirebaseAuth` | `admin` |

### 23.6 Dashboard — 19

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 28 | `GET` | `/v1/dashboard/my-restaurants` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 29 | `GET` | `/v1/dashboard/my-restaurant` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 30 | `GET` | `/v1/dashboard/restaurant/:id` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 31 | `GET` | `/v1/dashboard/admin` | `verifyFirebaseAuth` | `admin` |
| 32 | `GET` | `/v1/dashboard/ops/overview` | `verifyFirebaseAuth` | `admin` |
| 33 | `GET` | `/v1/dashboard/reservations` | `verifyFirebaseAuth` | `admin` |
| 34 | `PUT` | `/v1/dashboard/restaurant/:id` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 35 | `GET` | `/v1/dashboard/restaurants` | `verifyFirebaseAuth` | `admin` |
| 36 | `DELETE` | `/v1/dashboard/restaurant/:id` | `verifyFirebaseAuth` | `admin` |
| 37 | `POST` | `/v1/dashboard/restaurant/:id/message` | `verifyFirebaseAuth` | `admin` |
| 38 | `PUT` | `/v1/dashboard/reservations/:id/status` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 39 | `POST` | `/v1/dashboard/reservations/:id/confirm-attendance` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 40 | `POST` | `/v1/dashboard/reservations/:id/mark-no-show` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 41 | `POST` | `/v1/dashboard/reservations/:id/ticket` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 42 | `POST` | `/v1/dashboard/points/add-manual` | `verifyFirebaseAuth` | `admin` |
| 43 | `POST` | `/v1/dashboard/points/racha/set` | `verifyFirebaseAuth` | `admin` |
| 44 | `POST` | `/v1/dashboard/points/racha/delta` | `verifyFirebaseAuth` | `admin` |
| 45 | `POST` | `/v1/dashboard/points/racha/unclaim-today` | `verifyFirebaseAuth` | `admin` |
| 46 | `GET` | `/v1/dashboard/users` | `verifyFirebaseAuth` | `admin` |

### 23.7 Administración — 2

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 47 | `GET` | `/v1/admin/revenue` | `verifyFirebaseAuth` | `admin` |
| 48 | `GET` | `/v1/admin/fraud-flags` | `verifyFirebaseAuth` | `admin` |

### 23.8 Reseñas — 5

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 49 | `POST` | `/v1/reviews` | `verifyFirebaseAuth` | — |
| 50 | `GET` | `/v1/reviews/user/:usuarioId` | — | — |
| 51 | `GET` | `/v1/reviews/:restauranteId` | — | — |
| 52 | `POST` | `/v1/reviews/:id/like` | `verifyFirebaseAuth` | — |
| 53 | `DELETE` | `/v1/reviews/:id/like` | `verifyFirebaseAuth` | — |

### 23.9 Invitaciones — 3

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 54 | `POST` | `/v1/invite` | `verifyFirebaseAuth` | — |
| 55 | `POST` | `/v1/invite/accept` | `verifyFirebaseAuth` | — |
| 56 | `GET` | `/v1/invite/my` | `verifyFirebaseAuth` | — |

### 23.10 Promociones e interacciones — 4

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 57 | `GET` | `/v1/promotions` | — | — |
| 58 | `POST` | `/v1/promotions` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 59 | `GET` | `/v1/promotions/:id/stats` | `verifyFirebaseAuth` | `empresa`, `admin` |
| 60 | `POST` | `/v1/interactions` | `verifyFirebaseAuth` | — |

### 23.11 Tickets — 2

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 61 | `GET` | `/v1/tickets` | `verifyFirebaseAuth` | — |
| 62 | `GET` | `/v1/tickets/:id` | `verifyFirebaseAuth` | dueño, `empresa` o `admin` |

### 23.12 Negocios — 5

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 63 | `POST` | `/v1/negocios` | `verifyFirebaseAuth` | — |
| 64 | `GET` | `/v1/negocios/my` | `verifyFirebaseAuth` | — |
| 65 | `GET` | `/v1/negocios/pendientes` | `verifyFirebaseAuth` | `admin` |
| 66 | `PUT` | `/v1/negocios/:id/aprobar` | `verifyFirebaseAuth` | `admin` |
| 67 | `PUT` | `/v1/negocios/:id/rechazar` | `verifyFirebaseAuth` | `admin` |

### 23.13 Contacto — 4

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 68 | `POST` | `/v1/contactos` | `optionalAuth` | — |
| 69 | `GET` | `/v1/contactos/mine` | `verifyFirebaseAuth` | — |
| 70 | `GET` | `/v1/contactos/pending` | `verifyFirebaseAuth` | `admin` |
| 71 | `PUT` | `/v1/contactos/:id/resolve` | `verifyFirebaseAuth` | `admin` |

### 23.14 Mensajes — 3

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 72 | `GET` | `/v1/mensajes` | `verifyFirebaseAuth` | — |
| 73 | `GET` | `/v1/mensajes/unread-count` | `verifyFirebaseAuth` | — |
| 74 | `PUT` | `/v1/mensajes/:id/read` | `verifyFirebaseAuth` | — |

### 23.15 Lista de espera — 3

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 75 | `POST` | `/v1/espera` | `verifyFirebaseAuth` + `rateLimit(20/min)` | — |
| 76 | `GET` | `/v1/espera/mias` | `verifyFirebaseAuth` | — |
| 77 | `DELETE` | `/v1/espera/:id` | `verifyFirebaseAuth` | — |

### 23.16 Reserva en grupo JAM — 9

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 78 | `POST` | `/v1/jams` | `verifyFirebaseAuth` + `rateLimit(10/h)` | — |
| 79 | `GET` | `/v1/jams/mias` | `verifyFirebaseAuth` | — |
| 80 | `GET` | `/v1/jams/:codigo` | `optionalAuth` | — |
| 81 | `GET` | `/v1/jams/:codigo/stream` | — | — |
| 82 | `POST` | `/v1/jams/:codigo/unirse` | `verifyFirebaseAuth` + `rateLimit(20/min)` | — |
| 83 | `PUT` | `/v1/jams/:codigo/voto` | `verifyFirebaseAuth` + `rateLimit(60/min)` | — |
| 84 | `POST` | `/v1/jams/:codigo/salir` | `verifyFirebaseAuth` | — |
| 85 | `POST` | `/v1/jams/:codigo/cerrar` | `verifyFirebaseAuth` | anfitrión |
| 86 | `POST` | `/v1/jams/:codigo/cancelar` | `verifyFirebaseAuth` | anfitrión |

### 23.17 Métricas — 1

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 87 | `GET` | `/v1/metricas/directo` | `verifyFirebaseAuth` | `admin` |

### 23.18 Auditoría — 17

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 88 | `POST` | `/v1/auditoria` | **`optionalAuth`** + `rateLimit(240/min)` | — |
| 89 | `POST` | `/v1/auditoria/batch` | **`optionalAuth`** + `rateLimit(120/min)` | — |
| 90 | `GET` | `/v1/auditoria/overview` | `verifyFirebaseAuth` | `admin` |
| 91 | `GET` | `/v1/auditoria/series` | `verifyFirebaseAuth` | `admin` |
| 92 | `GET` | `/v1/auditoria/breakdown` | `verifyFirebaseAuth` | `admin` |
| 93 | `GET` | `/v1/auditoria/actividad` | `verifyFirebaseAuth` | `admin` |
| 94 | `GET` | `/v1/auditoria/usuarios` | `verifyFirebaseAuth` | `admin` |
| 95 | `GET` | `/v1/auditoria/logs` | `verifyFirebaseAuth` | `admin` |
| 96 | `GET` | `/v1/auditoria/usuario/:uid` | `verifyFirebaseAuth` | `admin` |
| 97 | `GET` | `/v1/auditoria/usuario` | `verifyFirebaseAuth` | `admin` |
| 98 | `GET` | `/v1/auditoria/export` | `verifyFirebaseAuth` | `admin` |
| 99 | `GET` | `/v1/auditoria/estado` | `verifyFirebaseAuth` | `admin` |
| 100 | `PUT` | `/v1/auditoria/ajustes` | `verifyFirebaseAuth` | `admin` |
| 101 | `GET` | `/v1/auditoria/sim/estado` | `verifyFirebaseAuth` | `admin` |
| 102 | `POST` | `/v1/auditoria/sim/run` | `verifyFirebaseAuth` | `admin` |
| 103 | `POST` | `/v1/auditoria/sim/reset` | `verifyFirebaseAuth` | `admin` |
| 104 | `POST` | `/v1/auditoria/purge` | `verifyFirebaseAuth` | `admin` |

### 23.19 Agente IA — 1

| # | Método | Ruta | Auth | Roles |
|---|---|---|---|---|
| 105 | `POST` | `/v1/ai/agent` | `optionalAuth` + `rateLimit(10/min)` + `idempotency` | por tool |

---

## 24. Observaciones de seguridad derivadas del código

Puntos donde el código actual **no** aplica control de acceso, documentados porque son relevantes para el cliente y para cualquier auditoría:

| Endpoint | Observación |
|---|---|
| `PUT /v1/restaurants/:id` | Cualquier usuario autenticado edita cualquier restaurante: no comprueba propiedad ni rol (`restaurants/routes.js:95`). |
| `GET /v1/tickets/:id` | Cualquier `empresa` lee cualquier ticket: la comparación es por rol, no por `restaurantId` (`tickets/service.js:58`). |
| `GET /v1/promotions/:id/stats` | Cualquier `empresa` lee estadísticas de cualquier promoción (`promotions/routes.js:41`). |
| `POST /v1/promotions` | La comprobación de dueño solo aplica si el restaurante tiene `ownerUid`; sin él, cualquiera puede crear promo (`promotions/service.js:13`). |
| `PUT /v1/mensajes/:id/read` | Marca como leído el mensaje de otro usuario: no valida `mensajes.uid` (`mensajes/service.js:19`). |
| `PUT /v1/contactos/:id/resolve` | Marca resuelta cualquier incidencia por id (`contactos/service.js:33`). |
| `GET /v1/reviews/user/:usuarioId` | Público y sin validar que el `usuarioId` corresponda a nadie concreto (`reviews/routes.js:41`). |
| `POST /v1/points/review` | Abona 20 puntos sin comprobar que exista una reseña (`points/service.js:200`). |
| `PUT /v1/dashboard/restaurant/:id` | Con rol `empresa` no se comprueba propiedad del restaurante (`dashboard/service.js:655`). |
| `POST /v1/dashboard/points/racha/unclaim-today` | Revierte la racha pero **no** devuelve los puntos ya abonados (`dashboard/service.js:814`). |
| `POST /v1/auditoria/purge` | Borra eventos reales; protegido solo por rol `admin` + confirmación literal `"PURGAR"`. |

Ninguno de estos puntos se puede cerrar desde el frontend: son cambios de backend.
### BUG-015 — invitaciones (Tanda 2)

`GET /v1/invite/my` añade `puntosTotales`; `aceptadas` cuenta ahora las invitaciones
**enviadas por el usuario** que han completado el requisito, en lugar de códigos
recibidos por él. El body de creación/aceptación no cambia. Tras dos reservas
completadas distintas, ambos usuarios reciben `PUNTOS_INVITACION` (200 por defecto)
y un movimiento individual; el ID de cada reserva evita contabilizarla dos veces.
El frontend construye el enlace `/#/registro?invite=<codigo>` en su propio dominio.
Despliegue: **backend primero, frontend después**. No es necesario enviar emails:
el usuario comparte el enlace con el destinatario indicado.

### BUG-011 — marcar todos los mensajes como leídos

`PUT /v1/mensajes/read-all`, autenticado, sin body. Responde
`{ "ok": true, "actualizados": <n> }`. Solo modifica mensajes del UID del token,
es idempotente y procesa lotes inferiores al límite de 500 escrituras.
Después consultar `/v1/mensajes/unread-count` para actualizar los contadores.
Despliegue: backend primero, frontend después.

### BUG-014 — autorización por recurso y validación

Las acciones de `PUT /dashboard/restaurant/:id`, `PUT /restaurants/:id`,
`PUT /reservations/:id/complete`, `POST /reservations/:id/ticket` y los cuatro
endpoints de estado/asistencia/ticket de `/dashboard/reservations/:id/*` exigen
propiedad del restaurante además del rol empresa/admin. La vinculación válida es
`restaurants.uid`, `restaurants.ownerUid` o la asignación server-side en
`usuarios.restaurantId(s)`. El email editable del perfil no acredita propiedad.
Admin mantiene acceso global; un ID ajeno devuelve 403 y uno inexistente 404.
`GET /tickets/:id` y `/promotions/:id/stats` aplican la misma pertenencia para empresas.
`PUT /mensajes/:id/read` solo admite mensajes del UID autenticado (403 si ajeno).

Los endpoints de escritura del dashboard usan Zod. Body de estado:
`{status: pendiente|confirmada|cancelada|completada|no_show, precioBase?: number > 0}`.
Confirmar asistencia/completar acepta `{precioBase?: number > 0}` o body vacío.
Marcar no-show acepta body vacío. Subir ticket acepta `{totalPagado: number > 0
|string decimal con punto/coma, asistio?: boolean, fileName?: string <= 300,
tipoDocumento?: string <= 100}`. Edición de restaurante descarta claves de metadatos/desconocidas,
valida límites de campos y solo admin puede cambiar `comisionPct` (0..100).
El formulario existente puede reenviar el documento completo: para empresa se
acepta una comisión idéntica a la persistida, pero se elimina del update.

Contacto público limita nombre/motivo a 200 y mensaje a 2000 caracteres, con
20 peticiones/minuto. La API aplica además 300 peticiones/minuto por IP,
compartidas entre rutas; health queda fuera. Helmet sigue activo y los errores 5xx
responden siempre `Error interno`; el detalle queda en logs del servidor.

Aceptación de invitaciones exige email del token coincidente y permite una sola
invitación por usuario, registrada en `invitaciones_aceptadas/{uid}`. Repetir el
mismo código ya aceptado por el mismo UID es idempotente; aceptar otro devuelve 409.

Despliegue: **backend primero; después publicar firestore.rules; después frontend**.
Las reglas de Firestore pasan a denegar todo acceso directo desde SDK cliente,
porque web y móvil acceden a los datos mediante mira-api. Admin SDK no depende de
estas reglas. Configurar/probar previamente el emulador de reglas y comprobar el
flujo en staging; este cambio no se ha publicado desde Codex.

### BUG-106 — tickets completos para documentos del restaurante

Las respuestas de `/v1/dashboard/my-restaurant` y `/v1/dashboard/restaurant/:id`
añaden `tickets`, array completo de los tickets del restaurante autorizado.
`ticketsRecientes` sigue siendo la vista previa de 20 registros. La consulta de
tickets ya no trunca a 500; CSV/factura usan `tickets`, después de filtrar el periodo.
El rol/pertenencia existentes siguen vigentes; no se exponen tickets de otros locales.
El dataset completo se devuelve en una respuesta para conservar el cambio mínimo;
con volúmenes muy elevados convendrá añadir paginación por cursor.
Despliegue: **backend primero, frontend después**. El nuevo frontend muestra error
si una respuesta antigua no incluye el dataset completo, evitando un documento
silenciosamente truncado. No requiere nuevas variables de Render/Vercel.

### BUG-113 — CORS, idempotencia y validación P2

**No hace falta configurar nada para desplegar.** Con `CORS_ALLOWED_ORIGINS` vacía (por defecto) se mantiene la política anterior: localhost:5173/4173 y cualquier `https://*.vercel.app`, así Vercel no se queda sin API. Si se rellena en Render, pasa a ser una lista estricta de orígenes exactos separados por comas: no admite comodines, protocolos distintos de HTTP(S), credenciales, rutas, query ni fragmentos, y una configuración inválida impide arrancar. Sin Origin siguen funcionando la app móvil y los clientes HTTP. CORS no sustituye a la autenticación ni a la comprobación de pertenencia.

**Otros ajustes de compatibilidad (revisión de Claude):**
- Rate limit global por IP: **1200 peticiones/min** por defecto (antes 300), configurable con `RATE_LIMIT_GLOBAL`. Varias personas detrás de la misma IP (oficina, demo) no se bloquean entre sí.
- Pertenencia de restaurante (`middlewares/ownership.js`): además de `uid`, `ownerUid` y `restaurantIds`, se acepta que el email del **token de Firebase** coincida con `restaurants.email`. Así los restaurantes antiguos enlazados solo por email no pierden acceso. No se usa el email del perfil, que sí se puede editar.
- `GET /v1/dashboard/my-restaurant` devuelve como máximo 5000 tickets (antes, sin límite tras BUG-106), para que un restaurante con mucho histórico no ralentice el panel.

Vercel no necesita una nueva variable del frontend; al crear un preview cuyo acceso
se desee, añadir explícitamente su origen a la variable de Render y reiniciar la API.
No se ha modificado ninguna configuración remota desde Codex.

`Idempotency-Key`: máximo 200 caracteres; namespace SHA-256 de usuario/método/ruta
concreta/key, evitando colisiones de otros endpoints o recursos. El body validado
se canonicaliza ordenando claves (arrays conservan orden). Repetir el mismo body
reproduce una respuesta 2xx; body distinto devuelve 409 `IDEMPOTENCY_CONFLICT` sin
invocar el handler. Errores no se cachean. Los documentos anteriores con ID uid_key
no se reutilizan; no hay migración ni borrado remoto. El mecanismo continúa siendo
best-effort si Firestore falla; no incorpora un lock distribuido de peticiones
simultáneas (sin cambio de esta característica en la tanda).

Cambios de validación HTTP (400 `VALIDATION_ERROR` si no se cumplen):

- `/users/me`: nombre trim 1..200; email válido <=254 o vacío; lang es/ca/en;
  favoritos máximo 500 IDs de 1..200, sin slash. Preferencias objeto estricto con
  vegano/soloVegano/vegetariano/sinGluten booleanos y alergias array (max7) del
  dominio gluten/lactosa/huevo/frutos_secos/marisco/pescado/soja. Accesibilidad
  estricta: sillaRuedas/tea booleanos. Cookies estrictas: necesarias solo true si
  se envía; preferencias/analiticas/marketing booleanos; timestamp ISO con offset
  o null. Estos tres objetos admiten null y propiedades opcionales para mantener
  actualizaciones parciales/formas válidas de la web.
- Crear reserva y consultar availability: ID de restaurante requerido, calendario
  YYYY-MM-DD real (incluye comprobación bisiesta) y HH:MM de 00:00 a23:59; el servicio
  sigue comprobando SLOTS. Reserva: comensales entero1..10 o string numérico,
  comentarios<=500 y nombres<=200/email<=254. Booleanos, arrays, decimales y '2x'
  se rechazan en el esquema antes de ejecutar la operación.
- Reseñas: comentario trim1..4000, puntuación entera1..5 e ID<=200 sin slash.
- Promociones: fechas de calendario/ISO válidas, fin>=inicio; presupuesto positivo
  finito<=1000000, CPC positivo finito<=100, puntos extra entero0..10000, tipo1..60
  e ID<=200 sin slash.
- Interacciones: ID trim1..200 sin slash y tipo view/click.

**Despliegue:** configurar CORS en Render, luego desplegar backend; frontend de
BUG-106 después del backend. Los cuerpos válidos de la web conservan contrato;
clientes con entradas antes aceptadas pero inválidas deben ajustarlas. No se ha
editado código de `modules/points` ni `modules/ai`.

## Push · T04

### POST /v1/push/tokens

Requiere `Authorization: Bearer <Firebase ID token>` (cualquier rol). Body estricto:

```json
{ "token": "ExponentPushToken[ejemplo]", "tipo": "expo", "plataforma": "android", "idioma": "es" }
```

Todos los campos son obligatorios. `tipo`: `expo` o `web`; `plataforma`: `android`, `ios` o `web`; `idioma`: `es`, `ca` o `en`. Token sin espacios, 1–4096 caracteres; Expo se valida con `Expo.isExpoPushToken`. Para web se recibe un **token FCM**, no una `PushSubscription`.

200: `{ "id": "<sha256 de tipo:token>", "tipo": "expo", "plataforma": "android", "idioma": "es" }`.
Registro idempotente en `usuarios/{uid}/dispositivos/{id}`: repetir actualiza metadatos y `actualizado` (ISO). El documento incluye `tokenHash` igual al ID. Al registrar, una transacción consulta `collectionGroup("dispositivos").where("tokenHash", "==", id)` y elimina el mismo token de otras cuentas antes de confirmar la reasignación. Esto evita depender del DELETE de logout para dejar de recibir avisos de la cuenta anterior. Máximo **10 dispositivos por usuario**: se conserva el registro actual y se eliminan los más antiguos por `actualizado` (desempate por ID). El UID procede exclusivamente del Bearer. El token no se devuelve ni se registra en logs.

Errores: 400 `VALIDATION_ERROR` con `details`; 401 `MISSING_TOKEN` o `INVALID_TOKEN` con `message`.

### DELETE /v1/push/tokens/:id

Misma autenticación. ID: 64 caracteres hexadecimales minúsculos. Solo elimina bajo el usuario autenticado, incluso para admins. 204 sin cuerpo también si no existe; 400 `VALIDATION_ERROR` para ID inválido; 401 como POST.
El cliente debe conservar el ID y borrar **antes de cerrar sesión**. Al cambiar de cuenta, borrar el registro anterior y registrar en la nueva.

### Envío interno y prueba manual

`require("./src/modules/push/service").enviarPush(uid, { tipo, titulo, cuerpo, data? })` envía a todos sus dispositivos: Expo Server SDK para `expo`, Firebase Admin Messaging para `web`. `tipo` es obligatorio (`reservas`, `mensajes` o `promociones`, T10). `data` es un mapa de cadenas; título 1–200 caracteres, cuerpo 1–2000. Devuelve `{ enviados, fallidos, eliminados }`: enviados significa aceptados por el proveedor, no confirmación de lectura o entrega. Un fallo de proveedor se aísla por dispositivo.

Se borran tokens Expo con `DeviceNotRegistered` en tickets y recibos, y FCM con `messaging/registration-token-not-registered` o `messaging/invalid-registration-token`; otros errores conservan el dispositivo. Los recibos se guardan en `push_recibos`, privados para la API. El cron cada 5 minutos revisa hasta 200 con al menos 15 minutos de antigüedad, reintenta los pendientes y los descarta a las 24 horas. En Render dormido, se retoma al despertar; no hay garantía de ejecución mientras duerme.

Firestore: propietario puede leer sus dispositivos; solo Admin SDK escribe. `push_recibos` deniega todo acceso desde clientes. Desplegar `firestore.rules` junto con el módulo. Antes de habilitar el registro, desplegar `firestore.indexes.json` y esperar a que el índice de campo `dispositivos.tokenHash` con ámbito `COLLECTION_GROUP` esté listo; si la consulta falla, la transacción no confirma el alta. La versión inicial de T04 no se desplegó: los dispositivos se crean ya con `tokenHash`. Si se hubieran guardado dispositivos de prueba con la versión inicial, borrarlos antes de habilitar esta versión, pues una consulta por `tokenHash` no encuentra documentos que carecen del campo.

Configuración fuera del repositorio: credencial Firebase con permisos FCM en Secret File de Render (`GOOGLE_APPLICATION_CREDENTIALS`); `EXPO_ACCESS_TOKEN` si Expo tiene habilitada seguridad push (opcional, declarada en `config/env.js` y `.env.example`). Android necesita FCM v1 configurado en EAS; la PWA necesita su token FCM y service worker (PC 2). Nunca subir claves FCM, VAPID ni cuentas de servicio.

Prueba conjunta tras registrar un dispositivo real, en un entorno con las credenciales anteriores:

```sh
PUSH_TEST_UID=uid-del-usuario node scripts/probar-push.js
```

El script envía un único aviso de prueba al usuario indicado y muestra solo contadores. Comprobar la llegada en Android y en la PWA y los recibos posteriores. No se expone un endpoint público de envío.

Referencias: [Expo Server SDK](https://github.com/expo/expo-server-sdk-node), [Firebase Admin Messaging](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk).

Índice de grupo de campo único: [documentación de Firestore](https://firebase.google.com/docs/firestore/query-data/index-overview).

### T05 · Avisos de reservas y mensajes

Se reutiliza `enviarPush` sin nuevos endpoints de envío. `push/notificar.js` contiene los textos es/ca/en; se seleccionan por `idioma` de cada dispositivo. El servicio admite opcionalmente `textos: { es?: { titulo, cuerpo }, ca?: { titulo, cuerpo }, en?: { titulo, cuerpo } }`; si falta la traducción usa el título/cuerpo base. Los campos base siguen siendo obligatorios; T10 añade `tipo` obligatorio a las llamadas internas (todos los emisores de la API y el script se han adaptado). Las traducciones tienen los mismos límites que el texto base y no se mandan como datos al proveedor.

| Evento persistido | Destinatario | Datos del push |
|---|---|---|
| Estado pasa a `confirmada` o `cancelada` desde dashboard/IA | `uid` de la reserva | `{ ruta: "reservas", reservaId, estado }` |
| Cancelación desde `PUT /v1/reservations/:id/cancel` por otra cuenta autorizada (admin) | `uid` de la reserva | `{ ruta: "reservas", reservaId, estado: "cancelada" }` |
| Nuevo mensaje mediante `mensajes/notificar.enviarMensaje` (espera/JAM incluidos) | UID destinatario del mensaje | `{ ruta: "mensajes", mensajeId }` |
| Mensaje de admin al dueño (`POST /v1/dashboard/restaurant/:id/message`) | UID dueño del restaurante | `{ ruta: "mensajes", mensajeId }` |

El mensaje de push del buzón es genérico y traducido: no muestra asunto ni contenido privado en la pantalla de bloqueo. Un mensaje pendiente de entrega por email, sin UID asociado, se guarda sin intentar push. No se modifica el contenido del buzón.

Las reservas nuevas siguen en `pendiente`; el aviso de confirmación se genera cuando el restaurante/admin cambia el estado a `confirmada`. Leer y actualizar el estado ocurre en una transacción y el aviso se envía **después de confirmar**; repetir el mismo estado no vuelve a notificar, y reintentar el callback de Firestore tampoco. Cancelar desde cliente/admin usa la transacción existente y mantiene el 409 si ya estaba cancelada. En esa ruta se omite el push cuando el actor es el propio titular (`reserva.uid === uid`), incluso si tiene rol admin; se sigue avisando al cliente cuando cancela otra cuenta autorizada. Los demás estados no generan un aviso T05.

Los avisos son best-effort: se intenta el envío tras la escritura, sin revertir la reserva/mensaje ni devolver error HTTP si falla push. No hay cola persistida ni reintento del evento de negocio; una caída entre el commit y el envío puede perder el aviso. Los recibos de Expo de T04 siguen revisándose como antes. Sin cambios en reglas o índices en T05. Preferencias y otros eventos se abordan en T10 o tareas posteriores.

Validación conjunta con PC 2: registrar un dispositivo T03/T07, crear una reserva con esa cuenta y confirmarla/cancelarla desde el panel de la empresa u otra cuenta admin; comprobar traducción según idioma del token y `data.ruta: "reservas"`. Enviar un mensaje desde admin o generar uno del buzón y comprobar `data.ruta: "mensajes"`. Repetir confirmación sin otro cambio no debe volver a avisar. La navegación al tocar depende de T03/T07; recepción real pendiente de disponer de esos dispositivos.

### T10 · Preferencias de notificaciones

Las preferencias se guardan en `usuarios/{uid}.preferenciasPush` y afectan al push de todos sus dispositivos. No modifican el buzón, las reservas ni la configuración Expo/FCM de los tokens.

#### GET /v1/push/preferencias

Autenticación: Firebase Bearer, cualquier rol. UID exclusivamente del token, sin parámetro para consultar otra cuenta. Respuesta 200, mapa completo:

```json
{ "reservas": true, "mensajes": true, "promociones": false }
```

Si no existe el perfil, el campo o una clave, reservas y mensajes tienen valor efectivo `true`, y promociones `false`. Promociones solo se activa con un `true` booleano explícito (`preferenciasPush.promociones === true`); valores como `"true"` o `1` no la habilitan. En reservas/mensajes solo un `false` explícito desactiva. GET no crea ni modifica documentos.

#### PUT /v1/push/preferencias

Misma autenticación. Actualización **parcial** con al menos una clave de `reservas`, `mensajes`, `promociones`, siempre booleanos; esquema estricto, sin claves adicionales, UID ni valores convertidos desde cadenas/números. Ejemplo:

```json
{ "promociones": false }
```

200: `{ "reservas": true, "mensajes": true, "promociones": false }` (mapa completo efectivo). Se combina en transacción con la configuración anterior para no perder otros interruptores ante peticiones simultáneas. Repetir el body es idempotente. `set` con merge conserva los otros campos del perfil; si este no existe, solo se crea `preferenciasPush`.

Errores: 400 `VALIDATION_ERROR` con `details` para body vacío/inválido; ambos endpoints devuelven 401 `MISSING_TOKEN` o `INVALID_TOKEN` si procede. Un fallo de Firestore sigue el errorHandler habitual.

#### Filtrado en enviarPush

Cada llamada interna debe declarar `tipo: "reservas" | "mensajes" | "promociones"`; un tipo ausente/desconocido se rechaza antes de leer o enviar. No se infiere desde `data.ruta`. T05 etiqueta sus confirmaciones/cancelaciones como `reservas`, y sus mensajes como `mensajes`; los emisores de promociones futuros deben indicar `promociones`.

Antes de consultar dispositivos, el servicio lee las preferencias del UID, sin caché. Si el tipo está desactivado, devuelve `{ enviados: 0, fallidos: 0, eliminados: 0 }` y no consulta dispositivos ni contacta a Expo/FCM. Los tokens se conservan; otras categorías y usuarios siguen funcionando. Si no puede leer las preferencias, falla sin enviar y el helper T05 mantiene la acción ya guardada.

Una actualización confirmada afecta al siguiente envío. No se pueden retirar avisos que ya estuvieran en curso o aceptados por el proveedor. No hacen falta índices o reglas nuevos; no se modifica el endpoint genérico de perfil ni el frontend.

Para PC 2: promociones empieza apagado hasta leer un `true` del servidor; nunca guardar `true` automáticamente al inicializar la pantalla. Enviar `{ promociones: true }` solo tras la activación explícita del usuario. Leer el mapa al abrir los ajustes, enviar únicamente el interruptor modificado y actualizar la UI con el mapa completo devuelto. Si la petición falla, no presentar el cambio como guardado. Prueba conjunta: desactivar promociones, comprobar que un emisor tipado no envía y que reservas/mensajes sí; reactivar y comprobar el siguiente envío. `scripts/probar-push.js` usa el tipo `reservas` y respeta su interruptor.
