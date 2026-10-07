# Informe técnico — Exceso de lecturas en Firestore (`COLLECTION /restaurants`)

**Para:** equipo frontend
**De:** equipo backend MIRA
**Motivo:** la base de datos gratuita se agotó ayer por exceso de lecturas

---

## 1. Qué pasó

| Dato | Valor |
|---|---|
| Lecturas a `restaurants` en un día | **44.000** |
| Cuota del plan gratuito | **50.000 lecturas/día** |
| Resultado | Cuota agotada → la API empieza a devolver `Quota exceeded` |
| Importe real | Un día de producción tirado por no revisar cómo se llamaban los endpoints |

## 2. Por qué tantas lecturas

El detalle importante: **una sola petición a `GET /v1/restaurants` cuesta ~690 lecturas**, porque el backend leía el catálogo entero (690 restaurantes) y filtraba en memoria.

Multiplicado por el patrón de uso del frontend, salía así:

| Patrón del frontend | Peticiones | Lecturas cada una | **Total** |
|---|---|---|---|
| Buscador sin debounce: escribir "sushi" = 5 llamadas | 5 | 690 | **3.450** |
| Cada página del catálogo recargada desde cero | ~20 | 690 | **13.800** |
| Descarga con `all=1` al abrir la app | 1-3 | 690 | **2.070** |
| Disponibilidad consultada **por cada tarjeta** (27 tarjetas) | 27 | 1 | 27 |

Una sola búsqueda escrita a mano en el buscador puede consumir **más que la cuota de un día**.

## 3. Lo que YA ha hecho el backend

- **Caché del catálogo en memoria** (5 min): búsquedas, contador, ficha y listados ahora cuestan **0 lecturas** con la caché caliente.
- **Índices de Firestore** añadidos para que el listado paginado no escanee todo.
- Endpoint nuevo de diagnóstico: `GET /v1/restaurants/cache/stats`.

> La caché es **una red de seguridad, no una excusa**. Sigue habiendo que corregir los patrones de llamada: si el frontend pide 5 veces lo mismo, seguirá gastando cuota en las peticiones que no son del catálogo (disponibilidad, reservas) yFolloweando el ancho de banda.

---

## 4. Cambios necesarios en el frontend

### P0 — Buscador con debounce, mínimo de caracteres y cancelación

**Problema:** cada tecla pulsada dispara una petición de 690 lecturas.

```jsx
import { useEffect, useRef, useState } from "react";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 450;

export function useRestaurantSearch(input) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);

  const q = (input || "").trim();

  useEffect(() => {
    if (q.length < MIN_CHARS) { setData(null); return; }

    setLoading(true);
    const timer = setTimeout(async () => {
      abortRef.current?.abort();              // cancela la anterior
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/v1/restaurants?q=${encodeURIComponent(q)}&limit=27`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(res.status);
        setData(await res.json());
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [q]);

  return { data, loading };
}
```

**Reglas:** mínimo 3 caracteres, 450 ms de espera, cancelar la petición anterior. Pasa de 5 peticiones a 1.

---

### P0 — Cachear resultados en el cliente y no repetir llamadas idénticas

Si el usuario vuelve a una pantalla, **no se vuelve a pedir lo mismo**.

```js
// src/lib/apiCache.js
const TTL = 60_000;
const cache = new Map();
const inflight = new Map();

export function cachedGet(key, fetcher, ttl = TTL) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);

  if (inflight.has(key)) return inflight.get(key);   // deduplica en vuelo

  const p = fetcher()
    .then((data) => { cache.set(key, { data, at: Date.now() }); return data; })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

export const getRestaurants = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const key = `restaurants?${qs}`;
  return cachedGet(key, async () => {
    const res = await fetch(`/v1/restaurants?${qs}`);
    if (!res.ok) throw new Error(res.status);
    return res.json();
  });
};
```

---

### P0 — No usar `all=1`

`all=1` descarga las 690 fichas completas (con reseñas incluidas) en una sola llamada.

```jsx
// MAL: 690 lecturas + payload enorme
fetch("/v1/restaurants?all=1")

// BIEN: paginado con cursor
const page = await getRestaurants({ limit: 27, cursor: nextCursor });
```

Guardar el `cursor` que devuelve la respuesta y pedir solo la página siguiente al hacer scroll. **No recargar desde la página 1** cuando el usuario vuelve atrás: reutilizar el estado.

---

### P1 — Disponibilidad: 1 llamada, no 27

**Problema:** consultar disponibilidad **por cada tarjeta** = 27 peticiones al pintar la página.

```jsx
// MAL: 27 peticiones al montar la lista
cards.map(c => <Card onLoad={() => getAvailability(c.id, fecha, hora)} />)
```

**Opción A (sin tocar backend):** pedir disponibilidad **solo al pulsar una tarjeta** (al abrir el detalle o el calendario).

**Opción B (mejor):** pedirla una sola vez para la fecha seleccionada y cachear por `restauranteId + fecha + hora`.

> Si os resulta cómodo, el backend puede añadir un endpoint batch
> (`GET /v1/reservations/availability?restauranteIds=a,b,c&fecha=…&hora=…`)
> que devuelva la disponibilidad de N restaurantes en 1 llamada. **Avisa y lo implemento.**

---

### P1 — Cuidado con los efectos que se disparan solos

- En desarrollo, **React StrictMode monta cada componente dos veces**: cualquier fetch dentro de un `useEffect` se duplica.
- No llamar a la API dentro de un `useEffect` sin dependencias concretas (`[]` está bien, pero revisa que no dependa de un objeto que se recree en cada render).
- No cargar datos que ya vienen en la respuesta de otra pantalla.

---

### P2 — Revisar el resto de pantallas

| Pantalla | Revisar |
|---|---|
| Inicio | ¿Pide `all=1`? ¿Repite peticiones al hacer scroll? |
| Detalle de restaurante | ¿Dispara disponibilidad aunque el usuario no la pida? |
| Dashboard de empresa | ¿Refresca en cada cambio de tab? |
| Mensajes / notificaciones | ¿Polling demasiado agresivo? Añadir `refetchInterval` mayor. |

---

## 5. Cómo medir que está funcionando

**En el backend** (sin desplegar nada más):
```bash
curl https://<tu-api>/v1/restaurants/cache/stats
```
```json
{ "cache": { "cargas": 1, "aciertos": 843, "ttlMs": 300000, "tamano": 690 } }
```
- `cargas` = lecturas **reales** a Firestore desde que arrancó el servidor.
- Si `cargas` no sube al navegar, la caché funciona.

**Objetivo:** bajar de 44.000 lecturas/día a **menos de 2.000**.

---

## 6. Checklist

- [ ] Buscador con debounce 450 ms
- [ ] Buscador con mínimo 3 caracteres
- [ ] Cancelar la petición anterior (AbortController)
- [ ] Cachear respuestas en cliente (60 s) y deduplicar en vuelo
- [ ] Eliminar cualquier llamada con `all=1`
- [ ] Paginación con `cursor`, sin recargar desde la primera página
- [ ] Disponibilidad: 1 llamada en vez de 27
- [ ] Revisar efectos que se duplican en StrictMode
- [ ] Revisar el polling de mensajes/notificaciones

---

## 7. Resumen en una frase

> Una petición al buscador cuesta lo mismo que leer el catálogo entero; con debounce, caché en cliente y sin `all=1`, el mismo caso de uso pasa de 3.450 lecturas a 690 (y a 0 con la caché del backend).