# Restaurante MIRA — Backend

Dos piezas separadas:

| Carpeta | Qué es |
|---|---|
| `yelp-connection/` | Scripts de datos: Yelp → Faker → Firestore (seed, utilidades, recordatorios) |
| `mira-api/` | API Express que el frontend usa como **único** intermediario con Firestore |

El frontend (`restaurante-mira-frontend`) **no** toca Firestore directamente: solo llama a `mira-api` (más la SDK de Firebase Auth para login/token).

### Raíz del monorepo (Render / comandos únicos)

`package.json` en la raíz deja arrancar cada pieza **desde la raíz** del repo (útil en Render u otros PaaS):

| Comando raíz | Qué hace |
|---|---|
| `npm start` / `npm run start:api` | Arranca **mira-api** (`node mira-api/src/server.js`) |
| `npm run start:yelp` | Ejecuta **yelp-connection** (`node yelp-connection/index.js`) |
| `npm run install:all` | `npm install` en ambas carpetas |
| `npm run ci:api` / `npm run ci:yelp` | Instalación limpia (`npm ci`) de cada una |
| `npm test` / `npm run dev` | Tests / watch de mira-api |

**Render — Web Service (mira-api):**

1. Repo: este backend, rama `main`.
2. **Root Directory** vacío (raíz del monorepo).
3. **Build Command:** `npm run ci:api`
4. **Start Command:** `npm run start:api`
5. **Env:** `NODE_ENV=production`, `PORT` (Render lo inyecta), `PROJECT_ID`, y credenciales Firebase  
   ( `GOOGLE_APPLICATION_CREDENTIALS` + archivo del service account, o el JSON pegado en una env var según montes el volumen/secrets).

**Render — Job / Worker (yelp-connection)** — es un script one-shot (seed), **no** un servidor HTTP:

1. Mismo repo.
2. **Build Command:** `npm run ci:yelp`
3. **Start Command:** `npm run start:yelp`
4. Tipo de servicio: *Background Worker* o cron/job (termina solo al acabar el pipeline).

Local, sin Render:

```bash
npm run install:all   # una vez
npm run start:api     # API en :3000
npm run start:yelp    # pipeline Yelp → Firestore
```

---

## 1. `yelp-connection` — Pipeline de datos

Fuente de verdad para pobler la colección `restaurants` (y auxiliares) en Firestore.

### Flujo principal (`index.js`)

1. **Yelp Fusion API** — descarga restaurantes en 4 ciudades de Cataluña (`Barcelona`, `Tarragona`, `Girona`, `Lleida`), paginando de 50 en 50 con tope 240 por ciudad (límite de Yelp).
2. **Mapeo** — solo campos esenciales: nombre, dirección, coordenadas, rating Yelp, precio, categorías, imagen, URL, etc.
3. **Reseñas sintéticas** — 50 por restaurante con `@faker-js/faker` (o Gemini opcional: `REVIEW_MOTOR=gemini` + `GEMINI_API_KEY`).
4. **Fotos Pexels** (opcional) — rellena `imagen_url` donde Yelp no trae imagen (`PEXELS_API_KEY`).
5. **Subida** — `firebase-admin` → colección `restaurants` (backup JSON local si no hay credenciales).

### Requisitos

```bash
cd yelp-connection
npm install          # firebase-admin, @faker-js/faker
# serviceAccountKey.json en esta carpeta (NO subir a git)
```

### Scripts npm

| Comando | Script | Descripción |
|---|---|---|
| `npm run llenar` / `npm start` | `index.js` | Yelp → reseñas → Firestore (pipeline completo) |
| `npm run borrar` | `borrar.js` | Vacía la colección `restaurants` (lotes de 400) |
| `npm run ver` / `npm run ver:restaurantes` | `ver-restaurantes.js` | Consulta restaurantes por terminal |
| `npm run ver:usuarios` | `ver-usuarios.js` | Lista usuarios de Firebase Auth |
| `npm run fotos` | `rellenar-imagenes.js` | Rellena fotos Pexels a las que no tienen |
| `npm run setup` | `setup-colecciones.js` | Crea colecciones (`resenas`, `reservas`) + despliega reglas Firestore |
| `npm run recordatorios` | `recordatorios.js` | Avisos 24h antes en la mensajería interna (con meteo + parkings) |

### Variables opcionales (PowerShell)

```powershell
$env:YELP_API_KEY="..."          # si no, usa la key embebida en index.js
$env:REVIEW_MOTOR="gemini"; $env:GEMINI_API_KEY="..."
$env:SOLO_CIUDAD="lleida"        # prueba barata: solo una ciudad
$env:PEXELS_API_KEY="..."        # fotos de relleno
node index.js
```

### Otros utilitarios

- `ver-restaurantes.js --list | --zona <texto> | --zonas | --nombre <texto> | <yelp_id> | --random`
- `ver-usuarios.js --list | --todos | --email <t> | --nombre <t> | --uid <uid>`
- `recordatorios.js --dry` → solo muestra lo que haría
- `parking.js` — parkings cercanos vía Overpass API (sin claves)
- `componerEmail.js` — lógica pura del texto del recordatorio

---

## 2. `mira-api` — API Express

Intermediario exclusivo frontend ↔ Firestore. Node ≥ 20.

### Puesta en marcha

```bash
cd mira-api
npm install

# Credenciales (una de estas):
#  a) serviceAccountKey.json en mira-api/
#  b) .env con GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json

cp .env.example .env   # y editar PROJECT_ID / PORT si hace falta

npm run dev             # node --watch src/server.js
# o
npm start               # node src/server.js
```

`GET http://localhost:3000/health` → `{ status: "ok", ... }`

### Variables de entorno (`.env`)

| Variable | Default | Descripción |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `PORT` | `3000` | Puerto HTTP |
| `PROJECT_ID` | `restaurante-mira-18e0c` | Proyecto Firebase |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Ruta al service account (o usar `serviceAccountKey.json` en la raíz de `mira-api/`) |
| `FIRESTORE_EMULATOR_HOST` | — | p.ej. `localhost:8080` para el emulador |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `100` | Rate limit global (endpoints concretos pueden ser más estrictos) |
| `PUNTOS_*`, `INVITACIONES_*`, `CPC_*`, `TICKET_*`… | ver `src/config/env.js` | Reglas de negocio de puntos, invitaciones, promos, tickets |

Los `.env` y `serviceAccountKey.json` están en `.gitignore` (raíz del backend).

### Autenticación y roles

- El frontend envía `Authorization: Bearer <ID_TOKEN>` de Firebase Auth.
- `verifyFirebaseAuth` valida el token y resuelve el rol desde `usuarios/{uid}.tipo` → `cliente` \| `empresa` \| `admin`.
- `authorize(...roles)` devuelve `403 FORBIDDEN` si el rol no está permitido.
- `optionalAuth` deja pasar sin token (público con usuario opcional).

### Colecciones Firestore usadas

`restaurants`, `usuarios`, `reservas`, `resenas`, `puntos_movimientos`, `invitaciones`, `tickets`, `promociones`, `negocios`, `contactos`, `mensajes`, `idempotencyKeys`, …

### Índices compuestos

`firestore.indexes.json` define los índices necesarios (p.ej. `reservas.uid + fecha DESC` para “Mis reservas”).

Desplegar una vez (o cuando cambie):

```bash
cd mira-api
firebase deploy --only firestore:indexes
```

Si en runtime falta un índice, Firestore devuelve un error con una URL de consola; la API tiene *fallbacks* en memoria para no romper la UI, pero **hay que desplegar los índices**.

### Emulador Firestore (opcional)

```bash
cd mira-api
firebase emulators:start --only firestore
# en otra terminal / .env:
# FIRESTORE_EMULATOR_HOST=localhost:8080
```

### Tests

```bash
npm test
# node --test "test/**/*.test.js"
```

- `test/helpers/mockFirebase.js` — mock de `firebase-admin` + Firestore en memoria + tokens de prueba (`base64url({uid,role,email})`).
- `health.test.js` — salud, 404, rutas públicas.
- `security.test.js` — 401 sin token, 403 por roles, validación zod 400, CORS/helmet.
- `api.test.js` — paginación/busqueda de restaurantes, reservas, puntos, users, reseñas, invitaciones.

Los tests **no** tocan Firestore real ni necesitan credenciales.

### CORS

Orígenes permitidos: `http://localhost:5173`, `https://mira.vercel.app`, `https://restaurante-mira-frontend.vercel.app`.

### Cron jobs (UTC)

| Schedule | Job | Estado |
|---|---|---|
| `0 1 * * 1` (lunes 01:00) | `cron/streaks.js` — racha semanal de reservas | Activo |
| `0 2 * * *` (a diario 02:00) | `cron/promotions.js` — cierra promos con presupuesto agotado | Activo |
| `*/15 * * * *` | `cron/autoComplete.js` — auto-completar reservas | **Desactivado** (el estado lo gestiona el dashboard al subir ticket) |

### Estructura

```
mira-api/
├── firebase.json / firestore.rules / firestore.indexes.json
├── package.json
├── src/
│   ├── app.js                 # Express + rutas montadas
│   ├── server.js              # listen + crons + shutdown
│   ├── config/env.js          # zod para process.env
│   ├── config/constants.js    # SLOTS, precios, helpers de puntos
│   ├── middlewares/
│   │   ├── verifyFirebaseAuth.js  # verify / optional / authorize / db
│   │   ├── validate.js            # zod
│   │   ├── rateLimit.js           # por uid+route (+ clearRateLimits para tests)
│   │   └── errorHandler.js        # requestId, logger, 404, errorHandler
│   └── modules/
│       ├── restaurants/  reservations/  points/  reviews/
│       ├── invitations/  promotions/  interactions/  tickets/
│       ├── users/  dashboard/  admin/  negocios/
│       ├── contactos/  mensajes/  cron/  audit/
│       └── ...
└── test/
    ├── helpers/mockFirebase.js
    ├── health.test.js  security.test.js  api.test.js
```

---

## 3. Endpoints (`/v1/...`)

Leyenda auth: `—` pública · `opt` optionalAuth · `auth` verifyFirebaseAuth · roles entre paréntesis.

### Salud

| Método | Ruta | Auth |
|---|---|---|
| GET | `/health` | — |

### Restaurants

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| GET | `/v1/restaurants` | opt | Query: `limit` (default **27**), `cursor`, `all=1`, `q`, `cocina`, `ciudad`, `zona`… Paginación por cursor (scroll infinito); `all=1` → catálogo completo. |
| GET | `/v1/restaurants/count` | opt | Total |
| GET | `/v1/restaurants/:id` | opt | Detalle |
| PUT | `/v1/restaurants/:id` | auth | Ownership/rol comprobado en el servicio |

### Reservas

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/reservations/availability?restauranteId&fecha&hora` | opt |
| POST | `/v1/reservations` | auth (validate + rateLimit + idempotency) |
| GET | `/v1/reservations?estado=` | auth |
| PUT | `/v1/reservations/:id/cancel` | auth (dueño o admin) |
| PUT | `/v1/reservations/:id/complete` | auth (empresa, admin) |
| POST | `/v1/reservations/:id/ticket` | auth (empresa, admin) |

Horas válidas: 11 franjas (`SLOTS` en `constants.js`). Estado inicial: `pendiente`.

### Puntos

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| GET | `/v1/points/balance` | auth | saldo + rachas |
| GET | `/v1/points/is-new-user` | auth | |
| GET | `/v1/points/ledger?tipo&limit` | auth | movimientos en `puntos_movimientos` |
| POST | `/v1/points/redeem` | auth | rateLimit 10/min |
| POST | `/v1/points/daily-login` | auth | racha diaria (grace days) |
| GET | `/v1/points/wheel/prizes` | auth | config ruleta |
| POST | `/v1/points/wheel` | auth | rateLimit 5/min; premio del día 7 |
| POST | `/v1/points/review` | auth | +20 pts, rateLimit 5/min |

**Ruleta:** solo si `rachaLoginDias >= 7` (403 `WHEEL_LOCKED` en otro caso). Al girar, la racha vuelve a 0.

### Reseñas

| Método | Ruta | Auth |
|---|---|---|
| POST | `/v1/reviews` | auth (rateLimit 5/min, +20 pts best-effort) |
| GET | `/v1/reviews/user/:usuarioId` | — |
| GET | `/v1/reviews/:restauranteId` | — |
| POST | `/v1/reviews/:id/like` | auth |
| DELETE | `/v1/reviews/:id/like` | auth |

### Invitaciones

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| POST | `/v1/invite` | auth | rateLimit 5/h, tope mensual; 2 reservas → 200 pts |
| POST | `/v1/invite/accept` | auth | email debe coincidir, uso único |
| GET | `/v1/invite/my` | auth | `{ enviadas, aceptadas, … }` |

### Promociones e interacciones

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/promotions?restauranteId&estado` | — |
| POST | `/v1/promotions` | auth (empresa, admin) |
| GET | `/v1/promotions/:id/stats` | auth (empresa, admin) |
| POST | `/v1/interactions` | auth (view/click + puntos + audit) |

### Tickets

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/tickets` | auth |
| GET | `/v1/tickets/:id` | auth (dueño o admin) |

### Usuarios / perfil

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/users/me` | auth |
| PUT | `/v1/users/me` | auth |
| GET | `/v1/users/me/is-admin` | auth |
| GET | `/v1/users/all` | auth (admin) |

### Dashboard

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/dashboard/my-restaurants` | auth (empresa, admin) |
| GET | `/v1/dashboard/my-restaurant?id=` | auth (empresa, admin) |
| GET | `/v1/dashboard/restaurant/:id` | auth (empresa, admin) |
| PUT | `/v1/dashboard/restaurant/:id` | auth (empresa, admin) |
| GET | `/v1/dashboard/admin` | auth (admin) |
| GET | `/v1/dashboard/ops/overview` | auth (admin) |
| GET | `/v1/dashboard/reservations?q&estado&limite` | auth (admin) |
| PUT | `/v1/dashboard/reservations/:id/status` | auth (empresa, admin) |
| POST | `/v1/dashboard/reservations/:id/confirm-attendance` | auth (empresa, admin) |
| POST | `/v1/dashboard/reservations/:id/mark-no-show` | auth (empresa, admin) |
| POST | `/v1/dashboard/reservations/:id/ticket` | auth (empresa, admin) |
| POST | `/v1/dashboard/points/add-manual` | auth (admin) | `{ uid, cantidad ±N, motivo? }` |
| POST | `/v1/dashboard/points/racha/set` | auth (admin) | `{ uid, dias: 0–7 }` (ultimoLogin=ayer → hoy reclamable) |
| POST | `/v1/dashboard/points/racha/delta` | auth (admin) | `{ uid, delta: ±1–7 }` (clamp 0–7) |
| POST | `/v1/dashboard/points/racha/unclaim-today` | auth (admin) | `{ uid }` deshace login de hoy |
| GET | `/v1/dashboard/users` | auth (admin) | lista + `rachaLoginDias`, `yaReclamadoHoy` |

### Admin

| Método | Ruta | Auth |
|---|---|---|
| GET | `/v1/admin/revenue` | auth (admin) |
| GET | `/v1/admin/fraud-flags` | auth (admin) |

### Negocios (propuestas de empresa)

| Método | Ruta | Auth |
|---|---|---|
| POST | `/v1/negocios` | auth |
| GET | `/v1/negocios/my` | auth |
| GET | `/v1/negocios/pendientes` | auth (admin) |
| PUT | `/v1/negocios/:id/aprobar` | auth (admin) |
| PUT | `/v1/negocios/:id/rechazar` | auth (admin) |

### Contacto y mensajes

| Método | Ruta | Auth |
|---|---|---|
| POST | `/v1/contactos` | opt (rateLimit 5/min) |
| GET | `/v1/contactos/mine` | auth |
| GET | `/v1/contactos/pending` | auth (admin) |
| PUT | `/v1/contactos/:id/resolve` | auth (admin) |
| GET | `/v1/mensajes` | auth |
| GET | `/v1/mensajes/unread-count` | auth |
| PUT | `/v1/mensajes/:id/read` | auth |

### Errores (formato)

```json
{ "error": "NOT_FOUND|MISSING_TOKEN|INVALID_TOKEN|FORBIDDEN|VALIDATION_ERROR|RATE_LIMITED|CONFLICT|...", "message": "..." }
```

Códigos habituales: `400` validación · `401` auth · `403` rol · `404` no existe · `409` conflicto · `429` rate limit.

---

## 4. Notas de implementación

- **Fechas** — el serializador JSON (`jsonReplacer` en `app.js`) convierte `Date` / Firestore `Timestamp` a ISO-8601.
- **Paginación restaurants** — lotes de **27** con cursor. La query usa
  `orderBy(rating_yelp, desc) + orderBy(__name__, desc)` para que
  `startAfter(rating, id)` no falle con *"Too many cursor values"*. Si falla
  el índice de Firestore, el servicio hace fallback en memoria (carga total +
  orden + cursor). El frontend siempre pinta de 27 en 27 (con o sin filtros).
- **Búsqueda `q`** — normalización insensible a acentos/mayúsculas en el backend.
- **Idempotency** — `POST /v1/reservations` acepta header `Idempotency-Key`.
- **Rate limit** — clave `uid + baseUrl + path` (los `POST /` de routers distintos no comparten contador). Tests llaman a `clearRateLimits()` en `beforeEach`.
- **No hacer push** — ramas de trabajo `feat/migration-mira-api`; este README no cubre despliegue de Vercel/Cloud Run salvo que se pida.

---

## 5. Relación con el frontend

| Frontend | Backend |
|---|---|
| `src/services/httpClient.js` | único cliente HTTP + adjunta ID token |
| `restaurantApi.js`, `reservaApi.js`, `resenasApi.js`, `perfilApi.js`, `puntos` (en `api.js`), `mensajesApi.js`, `contactoApi.js`, `negocioApi.js`, `incidenciaApi.js`… | llaman a `/v1/...` |
| `filterService.js` | filtrado/orden local; con filtros pide `all=1` pero la UI pinta de **27 en 27** con scroll infinito |
| Firebase Auth (`authApi.js`) | login/registro/ID token — **no** Firestore |

Build del frontend: `npm run build` (Vite) — sin llamadas directas a Firestore en los servicios de datos.
