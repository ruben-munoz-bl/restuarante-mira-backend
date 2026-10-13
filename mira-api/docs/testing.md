# Estrategia de testing — MIRA API

Referencia de cómo se prueba `mira-api`: qué corre, con qué herramientas, qué cubre cada
fichero y, sobre todo, **qué no se cubre**. Todo lo descrito aquí se ha verificado leyendo
el código y ejecutando la suite.

---

## 1. Marco actual

| Propiedad | Valor |
|---|---|
| Runner | **`node:test` nativo** (sin Jest, Mocha ni Vitest) |
| Comando | `npm test` → `node --test "test/**/*.test.js"` (`package.json:9`) |
| Versión de Node | `>= 20` (`package.json:12`). Probado con Node 24.21 |
| Driver HTTP | **`supertest`** ^7.3.0, única dependencia de desarrollo (`package.json:28`) |
| Base de datos en tests | **Firestore en memoria** (mock propio, no emulador) |
| Proveedor de IA en tests | **SDK de Gemini mockeado** (mock propio) |
| Caso de prueba | **Integración HTTP**: supertest contra la app Express real + Firestore mockeado |
| Framework de UI / E2E | **No existe** |
| Instrumentación de cobertura | **No existe** (sin `c8`, `nyc` ni `--experimental-test-coverage`) |
| Lint / formateo | **No configurado** (sin ESLint ni Prettier en el repo) |
| CI | **No configurado** (no hay `.github/workflows`) |

### 1.1 Resultado de la última ejecución

```
ℹ tests 190
ℹ suites 8
ℹ pass 190
ℹ fail 0
ℹ duration_ms 8370
```

> **Nota sobre el recuento.** 190 es lo que reporta el runner (`node --test
> "test/**/*.test.js"`) y suma las pruebas de los 10 ficheros más los 8 `describe(...)`
> que las envuelven. Algunas pruebas se generan en bucle (p. ej. la matriz 401 de
> `security.test.js`), así que contar ocurrencias de `test(` en el fuente da una cifra
> menor. Si usas estos números como referencia, contrasta siempre contra el runner.

### 1.2 Desglose por fichero

| Fichero | Tests | `describe` | Su bloque |
|---|---:|---:|---|
| `test/api.test.js` | 46 | 0 | Paginación y búsqueda de restaurantes, panel de admin, reservas, puntos/racha/ruleta, perfil de usuario, reseñas, invitaciones |
| `test/security.test.js` | 34 | 0 | Matriz 401 sin token (15 endpoints), 403 por rol, validación zod, CORS, no exposición de campos sensibles |
| `test/api-nuevo.test.js` | 36 | 0 | Endpoint `/mapa`, caché de catálogo y documento `_catalogo`, canje de descuentos, panel del restaurante, subida de ticket |
| `test/ai.test.js` | 23 | 0 | Agente: prompt, guardrails, confirmación en 2 pasos, idempotencia, fechas, degradación del provider, límite ReAct, rate limit |
| `test/auditoria.test.js` | 18 | 5 | Esquema, saneado de PII, periodos, escritura, agregados, export CSV, simulación y reset, compatibilidad con `/v1/interactions` |
| `test/mejorasMira.test.js` | 10 | 3 | Lista de espera con retención de plaza, JAM (votación y reserva automática), métricas en memoria |
| `test/logs.test.js` | 9 | 0 | Trazabilidad `logs`: bloques, anonimato, no datos sensibles, topes, pausa por fallo de Firestore |
| `test/health.test.js` | 7 | 0 | `/health`, 404 global, rutas públicas, cabeceras de `helmet` |
| `test/fotoGoogle.test.js` | 4 | 0 | `GET /v1/restaurants/:id/foto`: redirect 302, caché, 404, fallo de Google |
| `test/usuariosTipo.test.js` | 3 | 0 | `PUT /v1/users/me`: nobody se auto-nombra admin, cliente → empresa sí |
| **Total** | **190** | **8** | |

### 1.3 Helpers

| Fichero | Tamaño | Qué hace |
|---|---:|---|
| `test/helpers/mockFirebase.js` | 412 líneas | Reemplaza el módulo `firebase-admin` mediante `Module._load`. Implementa un Firestore en memoria: colecciones, documentos, `where` (solo `==` y `array-contains`), `orderBy` múltiple, `limit`, `offset`, `startAfter`, `count()`, `batch()`, `runTransaction()` (sin reintentos, pero **exige todas las lecturas antes de cualquier escritura**, como el Firestore real), `FieldValue.serverTimestamp/increment`. También mockea `admin.auth().verifyIdToken()`: decodifica el token en base64url en lugar de validarlo criptográficamente. Exporta `seed`, `seedBase`, `resetStore`, `tokens`, `store` y `mockDb`. |
| `test/helpers/mockGemini.js` | 83 líneas | Reemplaza `@google/generative-ai`. `generateContent` devuelve la respuesta encolada (`queueGemini`) o la del handler (`setGeminiHandler`), y registra cada llamada en `geminiCalls()` con `{ model, system, tools, contents }`. |

**Limitaciones relevantes de los mocks** (afectan a lo que los tests pueden demostrar):

- El mock de Firestore **no implementa Transactions reales**: `runTransaction` (`mockFirebase.js:235`) ejecuta el callback contra el estado compartido sin reintentos, sin rollback y sin aislamiento. Lo que **sí** hace (desde el fix del 500 al subir ticket) es reproducir la regla de Firestore de **lecturas antes de escrituras**: `tx.get()` después de un `tx.set`/`tx.update` lanza `Firestore transactions require all reads to be executed before all writes.`, así que una regresión de este tipo revienta en un test rojo en vez de en un 500 en producción. Un test que pase no demuestra que el código sea correcto ante concurrencia ni ante conflictos de transacción.
- `where` solo reconoce `==` y `array-contains`; **cualquier otro operador devuelve `true`** (`mockFirebase.js:65`). Los filtros `>=`, `<=`, `!=` e `in` no se verifican de verdad.
- `FieldValue.increment(n)` devuelve `n` en vez de un sentinel que se resuelve al leer. El código que dependa del incremento atómico no queda probado.
- El `verifyIdToken` del mock **acepta cualquier payload base64url con `uid`**. No se prueba la validación real de firma, caducidad ni audience de los ID tokens.
- Los documentos del mock se clonan con `clone()`, que convierte `Date` a ISO-8601. Hay tests que lo tienen en cuenta explícitamente (`api-nuevo.test.js:534`).

### 1.4 Cómo se ejecuta

```bash
# Suite completa (desde mira-api/)
npm test

# Equivalent, sin npm (útil en Windows donde la ExecutionPolicy bloquea npm.ps1)
node --test "test/**/*.test.js"

# Un solo fichero
node --test test/api.test.js

# Reporter legible por máquina
node --test --test-reporter=tap "test/**/*.test.js"
```

En PowerShell con la política de ejecución por defecto, `npm test` falla con
`npm.ps1 no se puede cargar...`. Es una restricción del shell, no del proyecto:
usa `node --test` directamente o `npm.cmd test`.

---

## 2. Reglas de oro al escribir un test

Estas reglas no están en un documento: están implícitas en los 10 ficheros existentes.
Son obligatorias para que el test funcione.

### 2.1 El mock se carga ANTES que la app

`installFirebaseMock()` parchea `Module._load` como efecto secundario del `require`. Si
`src/app.js` se carga antes, el módulo real `firebase-admin` queda cacheado en el
registro de Node y el mock ya no se aplica.

```js
const { seedBase, tokens } = require("./helpers/mockFirebase"); // 1º: instala el mock
const request = require("supertest");

let app;
before(async () => {
  app = require("../src/app");                    // 2º: la app, ya mockeada
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});
```

`test/api-nuevo.test.js` hace lo mismo pero con `require` en la línea suelta (línea 6),
lo que funciona igual mientras el helper se importe antes.

### 2.2 `beforeEach`: re-siembra y limpia el rate limit

```js
beforeEach(() => {
  seedBase();                 // limpia el store y siembra usuarios + 3 restaurantes
  clearRateLimits();          // sin esto, el 429 se filtra entre tests
});
```

`seedBase()` (`mockFirebase.js:349`) es **destructivo**: hace `resetStore()` y siembra
`usuarios` (`u-admin`, `u-emp`, `u-cli`, `u-cli2`) y `restaurants` (`r1`, `r2`, `r3`).
Todo lo que un test añada se pierde en el siguiente.

Hay que añadir invalidaciones de caché cuando el test toque datos de catálogo
(`api-nuevo.test.js:10-14`):

- `restaurantService.invalidarCatalogo()` — limpia la memoria **y** marca el documento
  `_catalogo` con `generadoAt: 0` para que nadie (ni otra instancia) lo sirva viejo.
- `restaurantService.vaciarMemoriaCatalogo()` — solo la memoria: simula un arranque en
  frío dejando el documento intacto.
- `restaurantService.invalidarCatalogoPorEscritura()` — además pone el flag `sucio`, que
  obliga a full scan aunque el recuento no cambie (renombrados).
- `dashboardService.invalidarPanelAdmin()`, si el test toca el panel de admin.

### 2.3 Tokens de prueba

```js
const { tokens, encodeToken } = require("./helpers/mockFirebase");

tokens.admin    // uid u-admin, role admin
tokens.empresa  // uid u-emp,  role empresa
tokens.cliente  // uid u-cli,  role cliente
tokens.cliente2 // uid u-cli2, role cliente
tokens.invalid  // "not-a-valid-token" → 401 INVALID_TOKEN

// Crear un rol o uid que no existe en los cuatro de fábrica:
const otro = encodeToken({ uid: "u-otro", role: "cliente" });
seed("usuarios", "u-otro", { uid: "u-otro", tipo: "cliente" }); // el doc también
```

El `seed("usuarios", ...)` es obligatorio: el rol se resuelve leyendo ese documento
(`verifyFirebaseAuth.js:29`), no desde el token.

### 2.4 Afirmar sobre el store, no solo sobre la respuesta

Un `201` no demuestra que se escribió lo correcto. El store es accessible:

```js
const { store } = require("./helpers/mockFirebase");
assert.equal(store.get("usuarios").get("u-cli").saldoPuntos, 1000);
const movs = [...store.get("puntos_movimientos").values()];
assert.ok(movs.some((m) => m.tipo === "canje_descuento" && m.puntos === -1000));
```

### 2.5 Formato de los códigos de error

La API responde con `{ error, message }` (`errorHandler.js:13`) y
`VALIDATION_ERROR` añade `details` (`validate.js:8`). Los tests afirman ambos campos
cuando aplican:

```js
assert.equal(res.status, 400);
assert.equal(res.body.error, "VALIDATION_ERROR");
assert.equal(res.body.error, "MISSING_TOKEN");   // 401 sin token
assert.equal(res.body.error, "FORBIDDEN");       // 403 por rol
```

---

## 3. Catálogo de cobertura por fichero

### 3.1 `test/health.test.js` — 7 tests

Infraestructura y rutas públicas.

| Caso | Qué fija |
|---|---|
| `GET /health` → 200 | `status: "ok"` + `timestamp` |
| `GET /v1/noexiste` → 404 | `error: "NOT_FOUND"` del 404 global (`app.js:72`) |
| `GET /v1/restaurants` público | Filtro `optionalAuth`, orden `rating_yelp` descendente |
| `GET /v1/restaurants/count` | `total` desde la caché de catálogo |
| `GET /v1/restaurants/:id` inexistente | 404 `NOT_FOUND` |
| `GET /v1/promotions` público | `data` es array |
| Cabeceras de `helmet` | `x-content-type-options`, `x-request-id` |

### 3.2 `test/api.test.js` — 46 tests

El fichero más denso en comportamiento de negocio. Se divide en seis bloques en el
código mediante comentarios separadores.

**Restaurantes: paginación progresiva y búsqueda (8)**
- Sin `limit` → tanda por defecto de 27 (`TAMANO_PAGINA`), `terminado: true` si cabe todo.
- `limit=2` → 2 items + `cursor` + `terminado: false`; orden `r2` (4.8) antes que `r1` (4.5).
- Segunda página con cursor → 1 item, `terminado: true`, **sin ids repetidos entre páginas**.
- `all=1` → catálogo completo, `cursor: null`.
- Filtro `cocina` y búsqueda `q` **insensible a acentos y mayúsculas** (`normalizar()` en `restaurants/service.js:367`).
- Búsqueda sin `all=1` → pagina **sobre el resultado filtrado**, no sobre la página cruda.

**Panel de admin (7)**
- `GET /v1/dashboard/restaurants` con admin → página + cursor; con cliente → 403.
- `PUT /v1/dashboard/restaurant/:id` → actualiza solo campos permitidos (`updated: true`).
- `POST .../message` → 201, resuelve `uid` del dueño, crea documento en `mensajes` con `leido: false`; sin dueño → 400.
- `DELETE .../restaurant/:id` → elimina y el `GET` posterior da 404; inexistente → 404; cliente → 403.

**Reservas (7)**
- Listado autenticado, creación válida (201 con `id` y `codigo`), `hora` fuera de `SLOTS` → 400, `comensales` fuera de rango → 400.
- `availability` público → 200 con `limite` numérico; restaurante inexistente → 404.
- Cancelar una reserva ajena → **403**; cancelar la propia → 200 y `estado: "cancelada"`.

**Puntos y racha (16)**
- `GET /balance` con la forma exacta que espera el frontend (`saldoActual`, `rachaLogin`, `rachaReservas`).
- `GET /is-new-user` devuelve booleano; `GET /ledger` devuelve `{ data: [] }`; `GET /wheel/prizes` → 5 premios.
- `POST /daily-login` → 200/201 con `puntos` o `yaReclamado`.
- Panel: `racha/set` (admin only, y deja hoy reclamable), `racha/delta` con clamp a 7 y a 0, `unclaim-today` (admin only, permite volver a reclamar).
- **Ruleta**: sin racha 7 → 403 `WHEEL_LOCKED`; con racha 7 → 201, `>= 20` puntos y racha reseteada a 0.
- `add-manual` admin suma y resta; cliente → 403; cantidad no entera → 400 `VALIDATION_ERROR`.

**Perfil y reseñas (4)**
- `GET /users/me`, `GET /users/me/is-admin` para cliente (false) y admin (true).
- `GET /v1/dashboard/users` incluye `rachaLoginDias` y `yaReclamadoHoy`.
- `POST /v1/reviews` válida → 201; `GET /v1/reviews/:id` público → `data` array.

**Invitaciones (1)**
- `GET /v1/invite/my` → forma `{ enviadas: [], aceptadas: number }`.

### 3.3 `test/api-nuevo.test.js` — 36 tests

Functionalidad añadida más recientemente: el endpoint del mapa, la caché de catálogo
introducida para no agotar la cuota de Firestore, el canje de descuentos y la subida de
ticket desde el panel.

**Endpoint `/mapa` y documento `_catalogo` (6)**
- `/mapa` devuelve exactamente los 8 campos de `CAMPOS_MAPA` y **el peso es menos de la
  mitad** que `all=1` (comparación de `JSON.stringify(...).length` sobre 30 restaurantes
  con reseñas y descripciones largas).
- `/mapa?ciudad=` filtra.
- El documento técnico `_catalogo` **nunca aparece como restaurante** ni en el listado ni
  en el contador (`DOC_CATALOGO`, `restaurants/service.js:127`).
- Hidratación desde **un** documento tras arranque en frío (`vaciarMemoriaCatalogo()`):
  se mide `estadisticasCache().cargasCompletas` antes y después para demostrar que no
  relee los restaurantes sueltos.
- Un restaurante nuevo **aparece en `/mapa` tras `invalidarCatalogo()`**, aunque exista
  el documento ligero (regresión: el documento marcado `generadoAt: 0` ya no se sirve).
- `_catalogo` obsoleto → se reconstruye: se siembra un restaurante nuevo por fuera del
  proceso, se comprueba que el mapa y la búsqueda lo ven y que `total` del documento pasa
  de 4 a 5 (frescura por `count()`, no solo por TTL).

**Canje de descuentos y `redeem` (9)**
- `POST /discount/claim`: 401 sin token; canjea 2000 → 1000 puntos, genera cupón `MIRA-*`
  en estado `activo`, deja el saldo descontado en Firestore y **un movimiento
  `canje_descuento` de -1000**; saldo insuficiente → 400 `INSUFFICIENT` **sin tocar el saldo**;
  descuento inexistente → 400; body vacío → 400 `VALIDATION_ERROR`.
- `GET /discounts` lista el catálogo con `puntos > 0` y `euros > 0`.
- `POST /redeem` acepta cuatro formas distintas del mismo concepto: `{puntos: 500}`,
  `{descuentoId: "5"}`, `{puntos: "500"}` y `{descuentoId: "5 €"}`, y un `descuentoId`
  numérico. Es una regresión documentada: el frontend mandaba `{descuentoId}` y recibía
  `VALIDATION_ERROR ("puntos Required")`.
- `redeem` sin puntos ni descuento → 400; con descuento inexistente → 400 con mensaje
  que casa `/descuento no existe/i`.

**Rendimiento de la caché (3)**
- `/mapa` **no escribe en Firestore en cada llamada**: se intercepta `doc.set` del mock
  y se exigen 20 cargas más sin **ni una** escritura.
- La caché sirve datos viejos mientras refresca: se fuerza la caducidad del TTL y se
  comprueba que `cargas` sube como mucho en 1.
- `arranque en frío`: la caché se hidrata del documento `_catalogo` y devuelve el catálogo
  completo sin releer los documentos sueltos.

**Contrato de la caché (2)**
- Con caché parcial (hidratada de `_catalogo`), `GET /restaurants/:id` **sí** trae la
  ficha completa con `resenas` y `direccion_completa` (relee el documento real).
- El TTL es de al menos 15 minutos (`CATALOG_CACHE_TTL_MS >= 900000`).

**Panel de admin y del restaurante (11)**
- El panel no lee colecciones enteras: se siembran usuarios, reservas y tickets y se
  comprueban los totales exactos (`totalUsuarios: 9`, `totalReservas: 5`).
- `my-restaurant` devuelve el restaurante completo con **todas** las claves que el frontend
  espera (`restaurante`, `finanzas`, `stats`, `proximasReservas`, `reservasHoy`,
  `reservasParaTicket`, `ingresosPorMes`, `ticketsRecientes`).
- `my-restaurants` lista los del usuario; respeta el orden de `restaurantIds`; **403** al
  pedir el panel de otro restaurante; el admin sí puede; sin restaurante → 404 con mensaje;
  lista vacía → **200 `[]` y no 404**.
- Si el `restaurantId` principal fue borrado, cae al siguiente existente; si el candidato
  también fue borrado → **404** con mensaje "ya no existe" (no el 404 de "sin restaurante").
- Editar un restaurante refresca `_catalogo`: el nombre nuevo se ve al instante y el
  documento técnico queda regenerado (esto es lo que hace `invalidarCatalogoPorEscritura`).

**Subida de ticket desde el panel (5)**
- Crea ticket, completa la reserva y suma a `finanzas_restaurante` (comisión 10 %,
  neto 90). El test comprueba los **tres** documentos afectados.
- Importe inválido (`""`) → 400 `VALIDATION_ERROR` y **sin ticket creado**.
- Reserva inexistente → 404, **no 500**.
- Subirlo dos veces → 409 `CONFLICT` con **un solo ticket** en Firestore.
- `asistio: false` marca la reserva como `no_show` y acepta importes con coma
  (`"45,50"` → `45.5`).

### 3.4 `test/security.test.js` — 34 tests

**Matriz 401 (15 + 3).** Las 15 rutas de la constante `PROTECTED` (`security.test.js:26`)
se prueban en bucle: balance, ledger, daily-login, listar reservas, mis invitaciones,
`users/me`, mensajes, tickets, `my-restaurants`, panel admin, `ops/overview`, revenue,
`users/all` y las escrituras de reseñas e interacciones. Todas deben dar
`401 MISSING_TOKEN`. Además: token inválido → `INVALID_TOKEN`, y cabecera `Authorization`
sin prefijo `Bearer` → 401.

**Matriz 403 (6).** Cliente contra panel admin, revenue y `users/all`; empresa contra
revenue; admin contra el panel → 200; empresa contra `my-restaurants` → 200; empresa sin
restaurante → 404 con mensaje explicativo.

**Validación zod (6).** `POST /reviews` con `puntuacion: 99`; `POST /points/redeem` sin
puntos y con puntos negativos; `POST /reservations` con fecha no válida; `POST /invite`
con email inválido; `PUT /users/me` con `tipo: "superuser"`.

**No exposición de datos (1).** El listado público de restaurantes no incluye `password`,
`serviceAccount` ni `privateKey`.

**CORS (2).** Se comprueba que `*.vercel.app` recibe su propio
`access-control-allow-origin` y que un origen desconocido (`https://evil.example`) no lo
recibe.

### 3.5 `test/ai.test.js` — 23 tests

El fichero más denso en reglas de negocio, y el único que fija el hash del prompt.

**Validación de entrada (1).** `message` obligatorio, no vacío, máx. 2000 caracteres;
`history` con máximo 10 mensajes y `role` alternando `user`/`model`.

**Flujo de lectura (1).** El handler del mock devuelve primero una llamada a tool
(`getRestaurant`) y después texto. Se comprueba que la respuesta trae `actions[0].tool`,
su `result.ok` y los datos, que la cabecera `X-Prompt-Hash` coincide con el snapshot, y
que el prompt del sistema **no contiene** ni un `Bearer <algo>`, ni `serviceAccountKey.json`,
ni `GEMINI_API_KEY=`.

**Guardrails (2)**
- *Anti-invento*: si el modelo afirma una nota y un precio sin haber consultado ninguna
  tool, se verifica que hace **un reintento** y que los datos inventados no llegan al
  usuario.
- *Permisos*: un cliente pide 100 puntos extra → la tool admin **ni se le declara** al
  modelo (`tools` no la incluye) y su saldo queda intacto.
- *Identidad*: un anónimo pide su saldo → `MISSING_TOKEN` en el resultado de la tool.

**Confirmación en dos pasos (1).** Reservar devuelve `needsConfirm.confirmId` y un
`summary` legible, **sin haber creado nada** en `reservas`. La segunda llamada con el
`confirmId` crea la reserva. La tercera con el mismo `confirmId` falla con un mensaje que
casa `/no es válida/`: es de un solo uso.

**Idempotencia (2).** Una `Idempotency-Key` sin `needsConfirm` no provoca 500 (Firestore
rechaza `undefined`) y la clave ausente no se serializa. Y un 500 previamente cacheado
**nunca se vuelve a servir**: se inyecta a mano un documento con `status: 500` y se
comprueba que la API responde con la respuesta real.

**Fechas (3).** El prompt incluye la fecha actual de `Europe/Madrid` y la regla de no
reservar en pasado. La tool `createReservation` **lanza** `VALIDATION_ERROR` para una
fecha pasada y para el mes ya transcurrido, sin tocar Firestore; y una franja de hoy que
ya pasó también se bloquea.

**Formato de la respuesta (2).** `sanearReply` elimina JSON crudo; `resumenLegible`
resume listas; un texto normal no se toca. Y si la tool responde y el modelo calla, el
agente entrega un resumen legible en vez de reventar con el JSON.

**Caché de catálogo (3).** Con la caché caliente, **diez** operaciones simultáneas
distintas (búsquedas, `all`, filtros, contador, ficha, por uid) **no generan ninguna carga
nueva** a Firestore. El contador y la ficha salen de memoria. La escritura de un
restaurante invalida y la lectura siguiente ve el cambio.

**Degradación y provider (2).** Si el provider lanza siempre, la API responde **200** con
`retryable: true` y texto (nunca 5xx al usuario, nunca "no está disponible"). Si falla
`AI_MODEL`, la segunda llamada usa `AI_FALLBACK_MODEL` y la respuesta lo refleja.

**Límites y flags (2).** El bucle ReAct se corta en 5 iteraciones de tools y, con datos,
los entrega en lugar de un error vacío. Y `AI_ENABLED_TOOLS` respeta los tres modos
(`""` → 7 core, lista explícita, `"all"`) **y todas las tools tienen handler**.

**Rate limit (1).** 10 peticiones-minute responden 200; la undécima da 429 `RATE_LIMITED`.

**Snapshot del prompt (1).** `PROMPT_HASH_SNAPSHOT = "e2185ae607d3ce4a"`. Si cambian
`context/MIRA_CONTEXT.md` o `guardrails/MIRA_GUARDRAILS.md`, el hash cambia y **el test
falla a propósito**. Hay que revisar el cambio y actualizar la constante.

### 3.6 `test/auditoria.test.js` — 18 tests en 5 bloques

Fija `process.env.AUDITORIA_SYNC_MS = "1"` antes de cargar la app para que la
sincronización de la copia en memoria sea inmediata.

**`esquema` (4)** — es el único bloque de tests unitarios真正的 del repo (llama a
`esquema.validarEvento` directamente):
- Un tipo fuera del catálogo se rechaza.
- Saneado de PII: `email`, `telefono` y `token` desaparecen; los textos largos con datos de
  contacto se sustituyen por `[oculto]`; los valores se cortan a 512 caracteres y hay un
  máximo de 15 claves. Las fechas ISO se conservan.
- Se descartan duraciones < 50 ms y el scroll se limita a 1 evento por sesión cada 2 s.
- Periodos en UTC: día, semana ISO (empieza en lunes), mes y `todo` (epoch, granularidad
  mensual). `claveSemanaISO` de `2026-01-01` es `2026-W01`.

**`POST /v1/auditoria` (5)**
- Anónimo: 202, `aceptados: 1`, y aunque el cliente diga `fuente: "sim"` y se atribuya un
  `actorUid`, el servidor impone `fuente: "real"` y `actorUid: null`. El `ipHash` es un
  hex de 16 caracteres.
- `horaDe` respeta la hora del cliente si es coherente (no futura, ≤ 2 min de margen) y usa
  la del servidor si es futura o antigua.
- Con sesión, el actor lo pone el servidor.
- Se ignoran bots, los eventos de panel que no vienen de un admin, y los lotes de más de
  100 eventos (400 y nada escrito).
- Con `registroActivo: false` no se escribe nada.

**`lectura (solo admin) y agregados compartidos` (5)**
- Un cliente recibe 403 **y el intento queda registrado** como `admin_acceso_denegado` con
  `resultado: "error"`. Este es el comportamiento de `authorize()` en
  `verifyFirebaseAuth.js:77`.
- `overview` muestra los eventos reales al momento e incluye `version` y `porFuente`.
- **Dos admins distintos reciben exactamente los mismos agregados** (`assert.deepEqual`):
  es la propiedad que justifica la copia compartida de `store.js`.
- `logs` pagina con cursor (5 + 3 de 8) y el timeline de un usuario incluye lo que hizo
  antes de iniciar sesión en ese mismo navegador (`anonId`) más las acciones del admin con
  su array `cambios`.
- El export CSV se registra a sí mismo como evento `export_auditoria`.

**`simulación` (2)** — el simulador es determinista: misma semilla, mismos eventos.
`run` + `reset` borra **solo** lo simulado y deja intactos los reales, y después de
limpiar `porFuente.sim` es 0.

**`compatibilidad` (2)** — `POST /v1/interactions` sigue escribiendo un evento
`interaccion` en el store nuevo. Y `ag.breakdown` calcula porcentajes, `share` acumulado
y `resto` correctamente, con `delta: null` cuando no hay base.

### 3.7 `test/mejorasMira.test.js` — 10 tests en 3 bloques

**Lista de espera (4)**
- No deja apuntarse si hay mesa libre → 409 `HAY_SITIO`.
- Al cancelarse una reserva se avisa al **primero** de la cola, se le **retiene la plaza**,
  solo él puede reservarla y la retención se consume al hacerlo. El aviso llega como
  mensaje de tipo `lista_espera` con un enlace `#/r/<id>?fecha=`.
- Si la retención caduca, la plaza pasa al siguiente de la cola (`RETENCION_MS`).
- Cancelar desde el panel también libera la plaza y avisa.

**JAM (5)**
- Lógica pura: el recuento ordena por más votado y, a empate, por franja con más gente;
  el código tiene 6 caracteres del alfabeto sin ambigüedades; la validación de propuesta
  devuelve los errores.
- Flujo completo: crear → unirse → votar en directo → cerrar. Solo el anfitrión cierra
  (403 si no). Al cerrar, reserva la combinación ganadora a su nombre y **avisa a los tres
  participantes**. Votar en una sala cerrada → 409.
- Si la ganadora está completa, reserva la siguiente combinación (`intentos: 2`).
- Cierre automático al vencer el plazo, con `cerradaPor: "automatico"`.
- 404 para un código inexistente y 400 por una franja en el pasado.

**Métricas en memoria (1)** — cuenta peticiones, errores 4xx y p95; excluye `/health` y
`/v1/metricas/*`; solo admin; `percentil` con un array de ejemplo.

### 3.8 `test/logs.test.js` — 9 tests

Fija `LOGS_ENABLED=true`, `LOGS_MAX_DOCS_DIA=3` y `LOGS_POR_DOC=4` antes de cargar la app.

- Petición anónima → `anonimo: true`, `uid: null`, `modulo` derivado de la ruta, `queryKeys`
  **sin valores** (solo las claves), y el bloque con `uids: []` y `expiraEn > desde`.
- Petición con sesión → `uid`, `rol`, ruta como patrón y el uid en el índice del bloque.
- Token en ruta pública → el usuario se identifica igualmente.
- Token inválido y 404 → anónimos y cuentan como errores del bloque.
- **No se guardan datos sensibles**: ni el body (email del contacto), ni el token, ni la IP
  en claro; `ipHash` sí es un hex de 16.
- `/health` y `OPTIONS` no se registran; 6 peticiones caben en 2 documentos con
  `LOGS_POR_DOC=4`.
- Al llegar a `LOGS_MAX_DOCS_DIA` deja de escribir.
- Si Firestore falla, **pausa** la escritura y la API sigue respondiendo 200; tras el error
  no reintenta durante la pausa.
- Apagado por defecto: sin `LOGS_ENABLED=true` no se escribe nada.

### 3.9 `test/fotoGoogle.test.js` — 4 tests

Sustituye `global.fetch` y restaura el original en `after`.

- Redirige (302) a la foto verificada, con cabecera `X-Foto-Autor` y el `location`
  exacto; la segunda llamada sale de la caché (no se repite el `fetch`).
- 404 si el restaurante no tiene foto de Google **o** si falta `GOOGLE_PLACES_API_KEY`.
- Si la foto verificada ya no existe en Google, **no** sirve otra sin verificar.
- Si Google responde 500 → 404 (la tarjeta usa su imagen de respaldo).

### 3.10 `test/usuariosTipo.test.js` — 3 tests

- Un cliente no puede hacerse admin (`PUT /users/me` con `tipo: "admin"` → 400, el tipo
  no cambia).
- Cliente → empresa sí se permite.
- Un admin no se rebaja a cliente desde su perfil, pero el resto de campos sí se guardan
  (esto está en `users/service.js:35-40`).

---

## 4. Qué **no** se cubre

Esta es la parte importante del documento. La suite es buena en regresiones de
comportamiento y en autorización, y **nula** en estructura, concurrencia e infraestructura.

### 4.1 Módulos sin ninguna prueba

| Módulo | Endpoints sin cubrir |
|---|---|
| `negocios` | **Los 5**: proponer, `my`, `pendientes`, `aprobar`, `rechazar` |
| `contactos` | `mine`, `pending`, `:id/resolve` (el `POST` solo se usa de paso en `logs.test.js`) |
| `mensajes` | `GET /`, `unread-count`, `PUT /:id/read` |
| `tickets` | `GET /` y `GET /:id` (ambos solo aparecen en la matriz 401) |
| `invitations` | `POST /` y `POST /accept` (solo se prueba `GET /my`) |
| `promotions` | `POST /`, `GET /:id/stats` |
| `reviews` | `GET /user/:usuarioId`, `POST /:id/like`, `DELETE /:id/like` |
| `reservations` | `PUT /:id/complete`, `POST /:id/ticket` |
| `dashboard` | `GET /reservations`, `GET /restaurant/:id`, `confirm-attendance`, `mark-no-show` |
| `restaurants` | `PUT /:id` directo, `GET /cache/stats` |
| `points` | `POST /review` |
| `jams` | `GET /mias`, `GET /:codigo/stream` (SSE), `POST /:codigo/salir`, `/cancelar` |
| `espera` | `GET /mias`, `DELETE /:id` |
| `auditoria` | `/series`, `/actividad`, `/usuarios`, `/estado`, `/ajustes`, `/sim/estado`, `/purge` |
| `admin` | `GET /fraud-flags` (`revenue` solo se prueba en 403) |
| `cron` | `streaks.js`, `promotions.js` y `autoComplete.js` **no tienen ningún test** |

### 4.2 Tipos de tests ausentes

| Tipo | Estado | Comentario |
|---|---|---|
| Tests unitarios de servicios | **Ausentes** | Casi todo se prueba por HTTP. Solo hay unitarios reales en `auditoria/esquema.js` |
| Tests de `agentLoop.js` | **Ausentes** | `withTimeout`, `executeTool`, `truncate` y el bucle ReAct se cubren solo de forma indirecta vía `/v1/ai/agent` |
| Tests de `jams/logica.js` | **1 solo caso** | `combinaciones`, `generarCodigo` y `validarPropuesta`; sin `vistaPublica` |
| Tests de `metricas.percentil` | **1 aserción** | Dentro de un test de endpoint |
| E2E / navegador | **Ausentes** | No hay Playwright ni Cypress |
| Tests contra Firestore real | **Ausentes** | Todo va contra el mock en memoria; el emulador está configurado (`firebase.json`) pero no se usa |
| Tests de `firestore.rules` | **Ausentes** | Las reglas solo afectan al cliente (el admin SDK las ignora), pero no hay verificación de que sigan alineadas con el modelo de datos |
| Tests de `firestore.indexes.json` | **Ausentes** | Hay dos `isIndexError()` de fallback en el código y **nada prueba que se disparen** |
| Concurrencia / transacciones | **Parciales** | El mock no reintenta ni hace rollback, pero **sí** exige lecturas antes de escrituras (la regla que rompía `subirTicket` en producción) |
| Pruebas de carga / rendimiento | **Ausentes** | Solo hay aserciones sobre el número de escrituras y lecturas de la caché |
| Mutación / fuzzing de entradas | **Ausentes** | `points/redeem` cubre algunos formatos raros, pero no hay fuzzing |

### 4.3 Qué no demuestra la suite, aunque pase

1. **Que el ID token se valide de verdad.** El mock acepta cualquier base64url con `uid`.
   Un cambio que rompa `verifyIdToken` real no lo detecta nadie.
2. **Que las transacciones sean atómicas.** `runTransaction` del mock no hace rollback ni
   reintenta; solo valida el orden lecturas→escrituras.
3. **Que los filtros de rango funcionen.** `where(">=", ...)` devuelve `true` en el mock.
4. **Que los índices compuestos estén desplegados.** Los dos `isIndexError()` que
   evitan un 500 en producción no tienen ningún test que los ejercite.
5. **Que el plan de Firestore aguante.** Los topes implementados (8000 eventos/día en
   auditoría, 1000 docs/día en logs) se prueban con valores de test, no con volumen real.
6. **Que el agente de IA se comporte bien con el prompt real.** El hash del snapshot
   detecta cambios en los `.md`, pero el mock siempre devuelve lo que el test le dicta:
   no se prueba la calidad de las respuestas, solo el andamiaje.

---

## 5. Cobertura por endpoint: resumen

De los **105 endpoints** de negocio documentados en `docs/api.md`:

- **Con al menos una prueba de éxito:** ~45
- **Con prueba solo de 401/403 (sin comportamiento):** ~18
- **Sin ninguna prueba:** ~42

La proporción es sana para el núcleo (restaurantes, reservas, puntos, autorización,
agente) y claramente insuficiente para la periferia (negocios, contactos, mensajes,
tickets, invitaciones, promociones, JAM, espera y todo lo de auditoría que no sea
escritura).

---

## 6. Recomendaciones

### 6.1 Antes de la siguiente funcionalidad

1. **Añadir cobertura de 401 a `GET /v1/tickets`, `GET /v1/mensajes`,
   `GET /v1/contactos/mine` y todos los endpoints de `negocios`.** Es barato: basta con
   añadir entradas al array `PROTECTED` de `security.test.js:26` y un par de casos de
   autorización. Eliminaría de golpe casi un tercio del hueco.
2. **Añadir al menos un caso de éxito y uno de autorización por cada módulo sin
   cobertura**, empezando por `negocios` (aprobar/rechazar es una operación
   administrativa con efecto real: crea documentos en `restaurants`).
3. **Probar los dos `isIndexError()`.** Basta con simular un error con
   `code: "failed-precondition"` en el mock y comprobar que la respuesta conserva la
   semántica. Hoy es código de producción sin ninguna red de seguridad.

### 6.2 Cuando el riesgo lo justifique

4. **Tests unitarios para `ai/agentLoop.js`.** Es el fichero con la lógica más sutil
   (corte del bucle ReAct, `withTimeout`, sanitizado de la respuesta) y se cubre solo de
   rebote. Un `describe` con el provider mockeado directamente daría Messages más
   precisos que los 23 tests actuales.
5. **Tests del cron `streaks`.** Recorre **toda** la colección de usuarios y hace una
   consulta por usuario (`cron/streaks.js:20-34`). Es el script con más riesgo de coste de
   Firestore del repo y no tiene ni un test.
6. **Un test de contrato sobre `firestore.rules` y `firestore.indexes.json`.** Que verifique
   que cada colección que aparece en `src/**/*.js` tiene su `match` en las reglas, y que
   cada consulta con `orderBy` + `where` compuesto tiene su índice. Convierte dos ficheros
   de configuración en algo que se puede revisar.
7. **Alguna forma de cobertura.** `--experimental-test-coverage` viene con `node:test` y no
   añade dependencias. No sustituye a pensar qué probar, pero evita que un módulo nuevo
   entre sin ninguna prueba por simple olvido.

### 6.3 Higiene

8. **Fijar el recuento de tests en un solo sitio.** La cifra ha pasado de 180 a 184, 189
   y 190 a lo largo de la última jornada porque el árbol estaba cambiando. Si se cita un
   número en documentación, conviene acompañarlo de la fecha o de la salida real del runner.
9. **`.gitignore` para `extract*.tmp.js`.** Añadido: hay dos scripts de extracción de datos
   (`extract.tmp.js`, `extract-cols.tmp.js`) sin trackear en la raíz de `mira-api` y no
   deben subirse.
10. **Script `npm run test:watch`.** `node --test --watch "test/**/*.test.js"` funciona en
    Node 20+ y no cuesta nada.

---

## 7. Referencia rápida

```js
// Arranque de un test nuevo
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");   // o require("node:assert")
const request = require("supertest");

const { seedBase, seed, store, tokens, encodeToken } = require("./helpers/mockFirebase");

let app;
before(async () => {
  app = require("../src/app");
  ({ clearRateLimits } = require("../src/middlewares/rateLimit"));
});

beforeEach(() => {
  seedBase();
  clearRateLimits();
});

test("nombre descriptivo en español", async () => {
  const res = await request(app)
    .get("/v1/ruta")
    .set("Authorization", `Bearer ${tokens.cliente}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
});
```

| Quiero… | Dónde mirar |
|---|---|
| Sembrar datos | `seed(coleccion, id, datos)` y `seedBase()` en `mockFirebase.js:349` |
| Un token nuevo | `encodeToken({ uid, role })` + `seed("usuarios", uid, { tipo })` |
| Ver qué se escribió | `store.get(coleccion)` |
| Respuestas del modelo | `mockGemini.queueGemini(...)` o `setGeminiHandler(...)` |
| Ver las llamadas al modelo | `geminiMock.geminiCalls()` |
| Invalidar cachés | `restaurantService.invalidarCatalogo()` (marca el doc `generadoAt: 0`), `vaciarMemoriaCatalogo()` (solo memoria), `invalidarCatalogoPorEscritura()` (además `sucio`), `dashboardService.invalidarPanelAdmin()` |
| Forzar la sincronización de auditoría | `process.env.AUDITORIA_SYNC_MS = "1"` antes de cargar la app |
| Resetear estado interno | `_reset()` en `metricas`, `auditoria/service`, `auditoria/store`, `jams/service`, `accessLog` |