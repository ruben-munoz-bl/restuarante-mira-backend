# Apuntes — El Agente IA de MIRA

Guía didáctica para explicar el agente en una presentación. Está pensado para **leerse en voz alta**: cada sección explica *qué es*, *por qué existe* y *cómo está montado*.

---

## 0. La idea en una frase

> Un único endpoint de chat que **responde usando nuestros datos reales** y además **ejecuta acciones**: reservar, consultar saldo, aprobar negocios. El frontend habla un solo idioma (español natural) y el backend sigue siendo la única fuente de verdad.

**Antes**: el frontend tenía que llamar a 13 módulos distintos, combinar respuestas y decidir qué botones mostrar.
**Ahora**: el frontend hace una llamada, recibe texto para mostrar + un registro de lo que la IA hizo.

---

## 1. Por qué esto es un problema real

Un usuario no piensa "endpoint `/v1/reservations/availability`". Piensa:

> *"Quiero cenar italiano el viernes a las 9 con dos personas."*

Traducir eso a llamadas técnicas es trabajo del desarrollador, cada vez, en cada pantalla. El agente es un **intérprete**: traduce lenguaje natural a operaciones de nuestra API, y mantiene las reglas de negocio intactas (no las duplica).

---

## 2. Cómo funciona por dentro (el bucle ReAct)

El modelo **no tiene los datos**. Cada vez que necesita algo, pide una herramienta y el servidor se la da.

```
  Usuario: "mesa para 2 en junio"
        │
        ▼
  ┌─────────────────────────────────────────┐
  │ System prompt: contexto + 10 reglas      │  ← qué sabe y qué no puede hacer
  └─────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────┐
  │  Gemini + catálogo de tools             │
  └─────────────────────────────────────────┘
        │
   ¿Necesita datos? ──sí──► llama tool ──► **services existentes** ──► resultado
        │                                              (nuestra lógica real)
        ▼
   Redacta la respuesta en español  ──►  reply
```

**ReAct** = *Reason + Act*: razona, actúa, observa, vuelve a razonar. Se repite hasta tener respuesta (máx. 5 vueltas, 20 s).

**Ejemplo real**: "Muéstrame las reseñas de Eden" → el modelo primero **busca** el restaurante (no sabe el id), recibe el id, y luego **pide las reseñas**. Dos herramientas encadenadas en un solo turno.

---

## 3. Las piezas del código

```
src/modules/ai/
│
├── routes.js         ◄── La puerta de entrada. 4 middlewares encadenados.
├── schemas.js        ◄── Valida lo que llega (nada de datos basura al modelo).
├── service.js        ◄── El director de orquesta.
├── agentLoop.js      ◄── El bucle: vueltas, tiempos, reintentos.
├── tools.js          ◄── El catálogo: 60 herramientas con su rol y sus parámetros.
├── handlers/         ◄── 6 ficheros con la lógica real, delegada en services.
│   ├── catalog.js  points.js  reservations.js
│   └── social.js   user.js    admin.js
├── provider/
│   ├── index.js      ◄── Registro de proveedores (estilo "intercambiable").
│   └── gemini.js     ◄── Implementación de Gemini + modelo de reserva.
├── systemPrompt.js   ◄── Arma el prompt y calcula su hash de versión.
├── confirmStore.js   ◄── Guardar las confirmaciones pendientes.
├── context/MIRA_CONTEXT.md        ◄── El conocimiento del negocio.
└── guardrails/MIRA_GUARDRAILS.md  ◄── Las 10 reglas de seguridad.
```

### Los dos ficheros markdown (lo más interesante del diseño)

El conocimiento y las reglas **no viven en el código**: viven en dos markdown editables.

| Fichero | Qué contiene | Ejemplo de regla |
|---|---|---|
| `MIRA_CONTEXT.md` | 15 secciones del negocio: ciudades, slots, cómo funcionan los puntos, la ruleta, las invitaciones, los tickets… | "La racha de 7 días abre la ruleta y resetea el contador" |
| `MIRA_GUARDRAILS.md` | 10 reglas cerradas de comportamiento | "Prohibido inventar datos" / "Nada de fechas pasadas" |

**Por qué es una buena decisión**: el prompt es un *producto* que se puede revisar, discutir y versionar como un documento. Cada respuesta lleva `X-Prompt-Hash` para saber con qué versión respondió el sistema.

---

## 4. El catálogo de tools

Una tool = una operación real. Cada una declara **qué rol puede usarla**, **si muta datos** y **qué parámetros acepta**.

| Papel | Nº de tools | Ejemplos |
|---|---|---|
| Público (sin login) | 33 | buscar restaurantes, ver ficha, consultar disponibilidad, promociones, reseñas |
| Cliente (+ login) | 44 | saldo, historial de puntos, mis reservas, mis tickets, mensajes, invitaciones, perfil |
| Empresa | 44 | mis restaurantes, actualizar ficha, subir ticket, cambiar estado de reserva, promociones |
| Admin | 60 | usuarios, facturación, métricas, señales de fraude, puntos manuales, rachas, aprobar negocios |

**60 tools en total, 29 de ellas modifican datos.** Cada rol ve un subconjunto: el modelo solo recibe las tools que le tocan.

### La regla de oro: la IA no toca la base de datos

Las tools **llaman a los services que ya teníamos** (`reservationService`, `pointsService`…). Cero acceso directo a Firestore desde el agente.

- No se duplica la lógica de negocio ✅
- No se puede saltarse una validación existente ✅
- Los puntos, los tickets y las reservas se calculan igual que siempre ✅

---

## 5. Acciones que modifican datos = 2 pasos

Reservar, cancelar, canjear puntos, subir ticket, aprobar un negocio… **nunca** ocurren en una sola llamada.

```
Usuario: "quiero reservar el 25/12 a las 21:00"
    │
    ▼
Agente llama createReservation
    │
    ▼
Backend responde: needsConfirm { confirmId, summary }   ← NADA se ha creado todavía
    │
    ▼
UI: "¿Confirmas? [Sí] [Cancelar]"
    │
    ▼
Usuario: "sí"  →  POST con confirmId
    │
    ▼
Backend ejecuta la acción real y devuelve el resultado
```

Propiedades del `confirmId`:
- **De un solo uso**: reenviarlo no repite la acción
- **Caduca a los 10 minutos**
- **Ligado al usuario** que lo pidió (el usuario B no puede confirmar lo del A)

**Por qué**: una IA que puede tocar datos sin control es un riesgo. Con el confirmId, el humano tiene siempre la última palabra.

---

## 6. Seguridad: 5 capas

| Capa | Qué protege |
|---|---|
| **Herramientas por rol** | El modelo *solo ve* las tools que le tocan. Un cliente ni de sabe que existen las de admin. |
| **Validación en 3 puntos** | Aunque el modelo se invente una tool, se comprueba rol → activación → si modifica datos. |
| **Confirmación en 2 pasos** | Ninguna acción destructiva sin un "sí" humano. |
| **Sin credenciales** | El modelo nunca ve tokens, claves ni la `Authorization`. El servidor usa la sesión del usuario por dentro. |
| **Reglas inyectadas** | Los guardrails tienen prioridad sobre cualquier instrucción del usuario (frente a prompt injection). |

Y una regla de oro de comportamiento: **si la herramienta falla, lo dice**. Nunca inventa datos para rellenar el hueco.

---

## 7. Rendimiento: por qué a veces "no está disponible"

Cada turno consume llamadas a Gemini. Con la cuota gratuita (~15 peticiones/min por modelo) hay dos modelos:

| Modelo | Latencia | Cuándo |
|---|---|---|
| `gemini-3.5-flash-lite` | ~1 s | Principal (rápido) |
| `gemini-3.5-flash` | 6-13 s | Reserva, si el principal falla |

**Decisión clave**: usar el rápido como principal **y** el potente como reserva. Cada modelo tiene su propia cuota, así que duplicamos el margen.

Además, el sistema se degrada con elegancia: si todo falla, **responde igual** con un `retryable: true` para que el frontend reintente solo, sin mostrar un error al usuario.

---

## 8. Los problemas que encontramos y cómo los resolvimos

Esta parte es la que demuestra el criterio técnico. ** prepping estos para el Daily:**

### 1. El modelo se rompía en la segunda vuelta
**Síntoma**: la primera búsqueda funcionaba; al pedirle datos de nuevo, la API devolvía error 400.
**Causa**: Gemini 3.x exige que al devolverle sus propias llamadas de herramientas incluya una firma criptográfica (`thoughtSignature`). Se estaba perdiendo al traducir los mensajes.
**Solución**: conservar el campo al reenviar el turno del modelo.

### 2. Los modelos del diseño ya no existían
**Síntoma**: todos los turnos devolvían "no disponible".
**Causa**: el modelo que usamos para el diseño devolvía 404.
**Solución**: probar los modelos disponibles y montar una cascada principal + reserva.

### 3. Las reservas salían en el pasado
**Síntoma**: "quiero reservar en junio" creaba la reserva en junio ya pasado.
**Causa**: el modelo **no sabía qué día es hoy**, así que resolvía el mes al año en curso.
**Solución**: inyectar la fecha/hora actual en el prompt + tres capas de validación que impiden físicamente una reserva en el pasado.

### 4. El frontend recibía 500 y Postman funcionaba
**Síntoma**: la web fallaba pero Postman iba bien.
**Causa**: el navegador manda una cabecera `Idempotency-Key` que Postman no. Esa cabecera activa un cache que guardaba la respuesta en Firestore… y nuestra respuesta incluía un campo vacío que Firestore rechaza. Peor: **el error quedaba cacheado** y se repetía para siempre.
**Solución**: no serializar campos vacíos, no cachear errores, y limpiar 45 respuestas fallidas que ya estaban guardadas.

### 5. Las etiquetas de cocina están en inglés
**Síntoma**: buscar "italiana" no encontraba nada.
**Causa**: los datos vienen de Yelp (`Italian`, `Tapas Bars`), y el filtro es exacto y sensible a mayúsculas.
**Solución**: la búsqueda intenta el filtro exacto y, si no hay resultados, repite con búsqueda por texto (que normaliza acentos y mayúsculas).

---

## 9. Números para la presentación

| Métrica | Valor |
|---|---|
| Endpoints nuevos | **1** |
| Tools operativas | **60** (0 sin implementar) |
| Acciones con confirmación | **29** |
| Tests automatizados | **105** (todos en verde) |
| Latencia por turno | 1-6 s |
| Límite por usuario | 10 peticiones/min |
| Lógica de negocio duplicada | **0 líneas** |
| Acceso directo a la BD desde la IA | **0** |

---

## 10. Cómo hacer la demo (2 minutos)

| Dices | Pasa | Por qué funciona |
|---|---|---|
| "Busca pizzerías en Barcelona" | Devuelve restaurantes reales con direcciones | Usa la API, no la memoria |
| "Muéstrame las reseñas de Eden" | Encadena 2 tools en un turno | Resuelve el id antes de pedir reseñas |
| "Quiero reservar para 4 el 25/12" | Pide confirmación, **no reserva** | El control humano |
| (Confirmas) | **Ahora sí** reserva | El confirmId se consume |
| "Dame 5000 puntos" | Se **niega** | Los guardrails no se saltan |
| "Reserva en junio" (ya pasado) | Lo rechaza y ofrece junio de 2027 | Sabe qué día es hoy |

Los dos últimos son los importantes: demuestran que **no es una caja negra**.

---

## 11. Límites actuales (sé honesto con esto)

- **Cuota**: el plan gratuito de Gemini da ~15 peticiones/min por modelo. Con varios usuarios concurrentes hay que pasar a plan de pago.
- **Latencia**: 1-6 s. Aceptable para chat, no para tiempos reales.
- **Validación pendiente**: los handlers nuevos se prueban con carga y datos reales, pero falta la validación de punta a punta autenticada (crear o reservar con un usuario real de Firebase).
- **Sin control de calidad automático** sobre las respuestas del modelo, más allá de los tests.

### Siguientes pasos naturales
1. Validar el flujo completo con usuarios reales.
2. Historial persistente de conversaciones (hoy vive en el frontend).
3. Métricas: turnos, tools más usadas, tasa de `retryable`.
4. Panel de analítica para admin speaking de forma natural.
5. Plan de pago de Gemini y subir el rate limit.

---

## 12. Glosario rápido

| Término | Significado |
|---|---|
| **Tool / herramienta** | Función que la IA puede ejecutar (una operación de nuestra API) |
| **ReAct** | Patrón "razona → actúa → observa" para usar herramientas |
| **System prompt** | Instrucciones fijas que recibe el modelo en cada llamada |
| **Guardrails** | Reglas que el modelo no puede saltarse |
| **Confirmación en 2 pasos** | Acción sensible = primero se pide permiso, luego se ejecuta |
| **Modifica datos** | Tool que crea, modifica o borra información (crear una reserva, canjear puntos…). Requiere confirmación. |
| **Idempotencia** | Reenviar la misma petición no duplica efectos |
| **Degradación elegante** | Si algo falla, se responde igual con un aviso en vez de cortar |

---

## 13. Preguntas que te van a hacer (con respuesta)

**"¿No se va a inventar cosas?"**
No: cada dato viene de una herramienta contra nuestra API. Además hay un detector automático que revisa la respuesta y, si encuentra un dato sin fuente, obliga al modelo a rehacerla. En las pruebas nunca se coló un restaurante inexistente.

**"¿Y si alguien intenta engañarla?"**
Los guardrails tienen prioridad sobre las instrucciones del usuario. Un cliente no puede pedir puntos ni aprobar negocios: esas herramientas ni siquiera se le ofrecen al modelo.

**"¿Puede tocar la base de datos directamente?"**
No, y es deliberado. Todo pasa por los services existentes, que ya tienen sus validaciones.

**"¿Cuánto cuesta?"**
Hoy, la cuota gratuita de Gemini (límite de ~15/min). Con plan de pago es céntimos por mil consultas.

**"¿Qué pasa si Gemini va lento o no responde?"**
El sistema tiene un modelo de reserva, reintentos con espera progresiva y, si todo falla, responde con `retryable: true` para que el frontend reintente solo.

**"¿Y si la IA se equivoca en una fecha?"**
Imposible reservar en el pasado: hay validación en el prompt, en las reglas y en el propio código que bloquea la operación.

---

## Frase de cierre para la presentación

> "No hemos creado una IA que sustituye al backend: hemos puesto una capa de conversación encima **usando** el backend. Las mismas reglas, los mismos datos, el mismo código de siempre. Solo que ahora el usuario habla en lugar de hacer clic."