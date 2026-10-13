# Scripts de `mira-api/scripts/`

Scripts de una sola ejecución que hablan con Firestore de producción usando las mismas
credenciales que la API (`serviceAccountKey.json` o `GOOGLE_APPLICATION_CREDENTIALS`).
No forman parte del servidor: se lanzan a mano y **escriben datos reales**.

| Script | Qué hace | Uso |
|---|---|---|
| `seed-demo-restaurante.js` | Simula actividad (reservas pasadas y futuras, tickets, `finanzas_restaurante` y puntos) de un restaurante para enseñar el panel de empresa. Todo lo creado lleva `seed: "demo-ari"`, así que se puede deshacer sin tocar datos reales. PRNG con semilla fija: la simulación sale igual cada vez. | `node scripts/seed-demo-restaurante.js` (por defecto, "Ari's Restaurant") · `--nombre "Otro"` · `--borrar` deshace la simulación |

## Consideraciones

- **Restaurante por nombre**: el script localiza el restaurante con
  `restaurants.where("nombre","==",NOMBRE)`; si no existe, falla con un mensaje claro.
- **Borrado selectivo**: `--borrar` solo elimina documentos con la etiqueta `seed:
  "demo-ari"` (reservas, tickets, movimientos de puntos y el agregado de finanzas se
  recalcula), no datos de usuarios reales.
- **Catálogo**: al crear reservas no toca `restaurants`, así que no hace falta invalidar
  `_catalogo`. Si añades un script que sí escriba en `restaurants`, recuerda que la caché
  del proceso de la API no se entera hasta que caduque el TTL o alguien llame a
  `invalidarCatalogo()`.

## Scripts que no se suben

`extract.tmp.js` y `extract-cols.tmp.js` (raíz de `mira-api`) son utilidades de extracción
puntual ya cubiertas por `.gitignore` (`*.tmp.js`): no commitearlas.
