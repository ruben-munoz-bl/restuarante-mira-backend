# MIRA — backend

Monorepo backend del proyecto MIRA (restaurantes + puntos de fidelización).

| Paquete | Qué es |
|---|---|
| [`mira-api/`](mira-api/) | API HTTP en Node 20+ / Express + Firebase Admin (Firestore, Auth). |
| [`yelp-connection/`](yelp-connection/) | Scripts de datos de restaurantes desde Yelp/Firestore. |

## Arranque rápido

```bash
npm run install:all   # instala mira-api y yelp-connection
npm run dev           # API en modo desarrollo (mira-api)
npm test              # suite de tests (mock de Firestore en memoria)
```

Requisitos: Node 20+, y en `mira-api/` las credenciales de servicio
(`serviceAccountKey.json`, ignorado por git) o la variable `GOOGLE_APPLICATION_CREDENTIALS`.
Configuración en `mira-api/.env` (ver `mira-api/.env.example`).

> En Windows, si `npm test` falla por la ExecutionPolicy de PowerShell, usa `npm.cmd test`
> o `node --test "test/**/*.test.js"`.

## Documentación

| Documento | Contenido |
|---|---|
| [`mira-api/docs/api.md`](mira-api/docs/api.md) | Referencia completa de los 105 endpoints: auth, errores, ejemplos `curl`. |
| [`mira-api/docs/base-de-datos.md`](mira-api/docs/base-de-datos.md) | Colecciones de Firestore, índices, relaciones y patrones de acceso. |
| [`mira-api/docs/testing.md`](mira-api/docs/testing.md) | Estrategia de tests, mocks, cobertura por fichero y huecos conocidos. |
| [`mira-api/docs/scripts.md`](mira-api/docs/scripts.md) | Scripts manuales que escriben en Firestore de producción. |

## Seguridad

- `serviceAccountKey.json`, `.env` y los JSON de datos de Yelp están en `.gitignore`: **no commitearlos nunca**.
- La autorización real vive en `verifyFirebaseAuth` + `authorize(roles)`; las reglas de
  `firestore.rules` solo protegen al cliente web.
