# Auditoría y trazabilidad (`logs`) — Guía didáctica

Cómo registramos cada petición a la API, qué guarda cada dato y por qué está diseñado así.

> **Estado actual:** los logs están **apagados por defecto** (`LOGS_ENABLED=false`). Hasta que los actives, esta funcionalidad no escribe nada y no consume cuota.

---

## 1. La idea en una frase

Cada petición deja **un registro** en la colección `logs`. Pero en vez de guardar un documento por petición (que agotaría la cuota de escrituras), los registros se **agrupan en bloques** de hasta 200.

```
Colección "logs"
 └─ documento 1 (≈80 KB)  ┐
 └─ documento 2 (≈80 KB)  ├─ cada bloque = hasta 200 peticiones
 └─ documento 3 (≈80 KB)  ┘
     └─ registros: [ {petición}, {petición}, ... ]
```

---

## 2. ¿Por qué es un JSON con campos separados?

Firestore es **NoSQL**: no hay columnas, ni tablas, ni esquemas. Cada documento es un JSON libre y **cada clave es un dato que Firestore indexa y por el que puedes filtrar**.

Si lo guardáramos todo junto, sería inútil:

```jsonc
{ "info": "GET /v1/restaurants/r1 por u-cli devolvió 200 en 42ms" }   // INÚTIL
```

No podrías responder a "¿cuántos errores 500 hubo?", "¿qué endpoint es más lento?" o "¿algún cliente intentó llamar a un endpoint de admin?".

Con campos separados:

```jsonc
{ "metodo": "GET", "path": "/v1/restaurants/r1", "uid": "u-cli",
  "rol": "cliente", "status": 200, "ms": 42 }
```

**Ahora sí puedes filtrar y cruzar datos.** Esa es la razón de que cada dato sea un campo: no es formato, es lo que convierte texto muerto en información consultable.

---

## 3. El bloque: qué guarda

```
logs/{id automático}
│
├── desde      Timestamp    del primer registro del bloque
├── hasta      Timestamp    del último
├── dia        String       "2026-10-07" (fecha UTC del primero)
├── n          Integer      cuántos registros contiene
├── errores    Integer      cuántos fueron status >= 400
├── uids       Array<String> usuarios únicos del bloque (filtrable)
├── modulos    Array<String> módulos únicos del bloque (filtrable)
│
├── registros  Array<Map>   el detalle, hasta 200 objetos
│   └── ... (ver sección siguiente)
│
└── expiraEn    Timestamp   desde + TTL (90 días). Solo se borra solo con plan Blaze
```

Los campos agregados (`n`, `errores`, `uids`, `modulos`) existen para **no tener que leer los 200 registros** cuando solo quieres un resumen o un filtro.

---

## 4. Cada registro: qué guarda y para qué

### Grupo A — ¿Qué se pidió? (identificar la operación)

| Campo | Ejemplo | Para qué sirve |
|---|---|---|
| `metodo` | `"GET"` | Distinguir **lectura** de **modificación** (`POST`/`PUT`/`DELETE`). Clave para auditar quién toca datos |
| `path` | `"/v1/restaurants/r1"` | El recurso exacto pedido |
| `ruta` | `"/v1/restaurants/:id"` | El patrón de Express, para agrupar todas las fichas en **un solo grupo** sin exploding cardinalidad |
| `modulo` | `"restaurants"` | Qué parte de la app recibe el tráfico (`restaurants`, `ai`, `reservations`…) |
| `queryKeys` | `["q","ciudad"]` | **Qué se buscó**, nunca los valores. Si guardara `?q=dni_de_marta` sería imposible filtrar y filtraría datos personales |

> **Por qué `ruta` y `path` están los dos:** `ruta` agrupa (1 valor para todas las fichas), `path` identifica (1 valor distinto por petición).

### Grupo B — ¿Quién lo pidió? (el actor) ⭐ el más importante

| Campo | Ejemplo | Para qué sirve |
|---|---|---|
| `uid` | `"u-cli"` | Quién exactamente |
| `rol` | `"cliente"` | **La pregunta de seguridad clave**: ¿algún cliente intentó llamar a un endpoint de `admin`? Eso es un intento de abuso |
| `anonimo` | `true` | Visitantes sin sesión |
| `ipHash` | `"fe40d361eb632e2e"` | Saber si es la misma persona desde otra IP, **sin guardar la IP real** (privacidad) |
| `userAgent` | `"Mozilla/5.0…"` | Navegador y dispositivo: "solo falla en Safari del iPhone" |
| `origen` | `"https://tu-frontend.vercel.app"` | Desde qué web llegó (control de CORS) |

### Grupo C — ¿Qué pasó? (el resultado)

| Campo | Ejemplo | Para qué sirve |
|---|---|---|
| `status` | `500` | `200` bien, `404` no existe, `500` error nuestro. Aquí ves la salud de la app |
| `ms` | `30012` | **Rendimiento**: qué endpoints son lentos |
| `errores` | `2` | Ya agregado a nivel de bloque: cuántos de esos 200 fallaron, sin leerlos uno a uno |

### Grupo D — ¿Con qué lo correlaciono?

| Campo | Ejemplo | Para qué sirve |
|---|---|---|
| `ts` | `2026-10-07T08:33:05Z` | Cuándo ocurrió; permite reconstruir la cronología |
| `requestId` | `"req_1791361985761_fc2lrk"` | **El hilo que une todo**: es el mismo que ya devuelve la API en cada error |

---

## 5. El `requestId`: cómo se investiga un fallo real

Imagina que un usuario escribe *"ayer no me dejó reservar"*:

**1.** En los logs del servidor de Render aparece su error:
```
ERROR requestId: req_1791361985761_fc2lrk
```

**2.** Buscas ese `requestId` en la colección `logs` y encuentras:
```
metodo:    POST
path:      /v1/ai/agent
uid:       u-cli          ← es este usuario
status:    500            ← falló de verdad
ms:        30012          ← tardó 30 s (¡por eso el usuario notó nada!)
queryKeys: ["message","confirmId"]
```

En **un segundo** sabes quién fue, qué intentó, por qué falló y cuánto tardó. Sin ese campo tendrías que buscar a mano entre miles de líneas.

Y al revés: ves muchos `status: 500` con `ms: 30000` → detectas que hay un endpoint lento, y antes de tocarlo ya tienes toda la evidencia.

---

## 6. Cómo se agrupan (por tiempo, no por usuario)

Los registros se agrupan **en el orden en que llegan**, en bloques, **no por usuario**:

```js
buffer.push(registro);                                    // 1. cada petición se apila
if (buffer.length >= 200) flushLogs();                    // 2. al llenarse, se corta
for (let i = 0; i < pendientes.length; i += 200) {        // 3. tajada posicional
  await db.collection("logs").add(bloque(trozo));
}
```

No hay ningún `groupBy(uid)`: un bloque **mezcla** a todos los usuarios que estuvieron ahí. El campo `uids` es solo una **etiqueta para filtrar después**, no el criterio de agrupación.

**¿Por qué no agrupar por usuario?** Porque fragmentaría la colección en miles de documentos de un registro, que es justo el problema que veníamos a evitar.

### ¿Por qué ningún bloque llega a 100?

Porque los 200 son un **techo, no un objetivo**. El bloque se corta cuando ocurre lo primero de estos dos:

| Disparador | Cuándo salta |
|---|---|
| Se llena el buffer (200) | Solo si entran 200 peticiones en la ventana (≈7 req/s sostenidos) |
| El temporizador (30 s) | **Siempre**, aunque haya entrado 1 sola petición |

Con tráfico normal gana el temporizador: cada bloque contiene lo que haya entrado en 30 segundos (2, 5, 15 peticiones). Además, cada reinicio del servidor vacía el buffer, así que también se escriben bloques parciales.

### ⚠️ Vigilar el tope diario

El límite es de **documentos, no de registros** (`LOGS_MAX_DOCS_DIA=1000`). Con 10.000 peticiones/día:

| Tamaño medio del bloque | Docs/día | ¿Se alcanza el tope? |
|---|---|---|
| 10 registros | 1.000 | **Sí, al límite** ⚠️ |
| 50 registros | 200 | No |
| 200 registros | 50 | No |

Si se supera, deja de escribir hasta el día siguiente y avisa en el log del servidor. Si tus bloques salen pequeños, **subir `LOGS_FLUSH_MS`** (ventana más larga → bloques más grandes → menos documentos).

---

## 7. Por qué no rompe la base de datos

| | Sin agrupar | Con el diseño actual |
|---|---|---|
| Escrituras por petición | 1 | **1 por cada 200** |
| Gasto diario | 20.000 (100% del plan) | **≤50 docs/día** (0,25%) |
| Peticiones trazadas | 20.000 | **hasta 200.000** |

Además lleva cinturones de seguridad:

- **Tope diario** (`LOGS_MAX_DOCS_DIA`): al llegar, deja de escribir hasta el día siguiente.
- **Pausa de 10 minutos** (`LOGS_PAUSA_MS`) si Firestore falla: descarta los registros en vez de reintentar en bucle.
- **Nunca bloquea al usuario**: escribe en segundo plano; si falla, la respuesta HTTP ya salió.
- **Buffer acotado** (`LOGS_MAX_BUFFER`): si se desborda, descarta los más antiguos.
- **Sin reintentos agresivos** ni índices sobre `registros` (indexar 200 mapas dispararía las escrituras).

Y un detalle importante: **escrituras y lecturas son cuotas distintas**. Los logs solo escriben, y **nadie los consulta** (no hay endpoint de lectura), así que hoy consumen **0 lecturas**.

---

## 8. Privacidad: qué NO se guarda

| No guardamos | Por qué |
|---|---|
| Tokens, cabeceras `Authorization` | Permitirían suplantar a un usuario |
| Bodies de la petición | Contienen datos personales y tarjetas |
| **Valores** de los query params | Solo los nombres (`["q","ciudad"]`); un valor podría ser un email o un DNI |
| La IP real | Solo su hash con salt: permite correlacionar sin exponer la dirección |

Las reglas de Firestore (`firestore.rules`) dejan `logs` **solo lectura para admin** y **escritura prohibida** desde el cliente.

---

## 9. Cómo activarlo

En Render, variables de entorno:

```
LOGS_ENABLED=true          # apagado por defecto; sin esto no se registra nada
LOGS_IP_SALT=<secreto>     # cambia el valor por defecto en producción
```

Opcionales para afinar el comportamiento:

| Variable | Default | Para qué |
|---|---|---|
| `LOGS_POR_DOC` | `200` | Registros por documento (máx. 500 por código) |
| `LOGS_FLUSH_MS` | `30000` | Cada cuánto se vuelca el buffer |
| `LOGS_MAX_DOCS_DIA` | `1000` | Tope de documentos por día |
| `LOGS_TTL_DIAS` | `90` | Retención (el borrado automático requiere plan Blaze) |

---

## 10. Cómo consultar (cuando exista un panel)

Los índices ya están creados para que la búsqueda sea barata:

```js
db.collection("logs")
  .where("modulos", "array-contains", "ai")
  .where("desde", ">=", new Date(Date.now() - 24 * 3600 * 1000))
  .orderBy("desde", "desc")
  .limit(20);              // siempre con límite
```

Para métricas de un panel, **basta con leer los últimos bloques** y usar sus campos agregados (`n`, `errores`, `uids`, `modulos`) sin tocar el array `registros`.

> **Nunca** hacer `db.collection("logs").get()` sin filtros: con hasta 90 días de retención, eso serían decenas de miles de lecturas.

---

## Resumen

| Pregunta | Campos |
|---|---|
| ¿Qué pidió? | `metodo`, `path`, `ruta`, `modulo`, `queryKeys` |
| ¿Quién? | `uid`, `rol`, `anonimo`, `ipHash`, `userAgent`, `origen` |
| ¿Qué pasó? | `status`, `ms`, `errores` |
| ¿Cómo lo sigo? | `ts`, `requestId` |

Cada campo está separado **para poder filtrar y cruzar datos**; `registros` es una lista de ellos porque así una sola lectura de Firestore devuelve 200 peticiones de golpe, y los bloques se agrupan **por tiempo de llegada**, no por usuario.