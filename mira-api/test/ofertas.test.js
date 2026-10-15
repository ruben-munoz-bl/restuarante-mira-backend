/**
 * G02 — ofertas por distancia (contrato fase 1): reglas de niveles, una sola
 * activa por restaurante, lectura pública de la vigente y permisos de dueño.
 */
const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { seedBase, seed, tokens, store, encodeToken } = require("./helpers/mockFirebase");
const { clearRateLimits } = require("../src/middlewares/rateLimit");

let app;
let logica;
let svc;
before(() => {
  app = require("../src/app");
  logica = require("../src/modules/ofertas/logica");
  svc = require("../src/modules/ofertas/service");
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const otraEmpresa = encodeToken({ uid: "u-emp2", role: "empresa", email: "emp2@test.local" });
const niveles = (pcts = [5, 10, 15, 20]) => [1000, 500, 100, 20].map((distancia, i) => ({ distancia, texto: `Nivel ${distancia} m`, descuentoPct: pcts[i] }));
const oferta = (extra = {}) => ({ restauranteId: "r1", titulo: "Menú de mediodía", activa: true, niveles: niveles(), ...extra });
const crear = (cuerpo, token = tokens.empresa) => request(app).post("/v1/ofertas").set(auth(token)).send(cuerpo);
const sinRestaurante = ({ restauranteId, ...resto }) => resto;

beforeEach(() => {
  seedBase();
  clearRateLimits();
  svc.invalidarCache();
  seed("usuarios", "u-emp2", { uid: "u-emp2", tipo: "empresa", email: "emp2@test.local", nombre: "Otra empresa" });
  // r1 es de u-emp; r2 de u-emp2.
  seed("restaurants", "r1", { ...store.get("restaurants").get("r1"), ownerUid: "u-emp" });
  seed("restaurants", "r2", { ...store.get("restaurants").get("r2"), ownerUid: "u-emp2" });
});

describe("reglas de niveles (logica)", () => {
  test("acepta niveles que mejoran o se mantienen y el de 20 m mejor que el de 1000 m", () => {
    assert.equal(logica.erroresNiveles(niveles([5, 10, 10, 20])), null);
  });
  test("rechaza orden distinto, niveles que faltan, que empeoran o llegada no mejor", () => {
    assert.match(logica.erroresNiveles(niveles().reverse()), /4 niveles/);
    assert.match(logica.erroresNiveles(niveles().slice(0, 3)), /4 niveles/);
    assert.match(logica.erroresNiveles(niveles([10, 5, 15, 20])), /igual o mejor/);
    assert.match(logica.erroresNiveles(niveles([10, 10, 10, 10])), /igual o mejor/);
  });
  test("vigente respeta activa, desde y hasta (incluidos)", () => {
    const o = { activa: true, desde: "2026-10-10", hasta: "2026-10-20" };
    assert.equal(logica.vigente(o, "2026-10-10"), true);
    assert.equal(logica.vigente(o, "2026-10-20"), true);
    assert.equal(logica.vigente(o, "2026-10-21"), false);
    assert.equal(logica.vigente({ ...o, activa: false }, "2026-10-15"), false);
  });
});

describe("POST /v1/ofertas", () => {
  test("la empresa dueña crea una oferta y la devuelve con id y fechas", async () => {
    const res = await crear(oferta());
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.restauranteId, "r1");
    assert.equal(res.body.niveles.length, 4);
    assert.equal(res.body.desde, null);
    assert.ok(res.body.creado && res.body.actualizado);
  });
  test("400 con detalles si los niveles empeoran o las fechas están al revés", async () => {
    const mal = await crear(oferta({ niveles: niveles([20, 10, 15, 25]) }));
    assert.equal(mal.status, 400);
    assert.equal(mal.body.error, "VALIDATION_ERROR");
    assert.ok(mal.body.details.niveles);
    const fechas = await crear(oferta({ desde: "2026-12-31", hasta: "2026-01-01" }));
    assert.equal(fechas.status, 400);
    assert.ok(fechas.body.details.hasta);
    assert.equal((await crear({ ...oferta(), extra: 1 })).status, 400, "campos desconocidos");
  });
  test("409 si ya hay otra activa; una inactiva sí se puede crear", async () => {
    assert.equal((await crear(oferta())).status, 201);
    const segunda = await crear(oferta({ titulo: "Cena" }));
    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.error, "CONFLICT");
    assert.equal((await crear(oferta({ titulo: "Cena", activa: false }))).status, 201);
  });
  test("permisos: 401 sin sesión, 403 cliente u otra empresa, 404 restaurante inexistente, admin sí", async () => {
    assert.equal((await request(app).post("/v1/ofertas").send(oferta())).status, 401);
    assert.equal((await crear(oferta(), tokens.cliente)).status, 403);
    assert.equal((await crear(oferta(), otraEmpresa)).status, 403);
    assert.equal((await crear(oferta({ restauranteId: "nope" }))).status, 404);
    assert.equal((await crear(oferta({ restauranteId: "r3" }), tokens.admin)).status, 201);
  });
});

describe("GET /v1/ofertas y /v1/ofertas/mias", () => {
  test("la pública solo devuelve la activa y vigente; mias devuelve todas", async () => {
    await crear(oferta({ titulo: "Antigua", activa: false }));
    await crear(oferta({ titulo: "Actual" }));
    const pub = await request(app).get("/v1/ofertas?restauranteId=r1");
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body.data.map((o) => o.titulo), ["Actual"]);
    const mias = await request(app).get("/v1/ofertas/mias?restauranteId=r1").set(auth(tokens.empresa));
    assert.equal(mias.body.data.length, 2);
  });
  test("una oferta activa fuera de su vigencia no sale en la pública", async () => {
    await crear(oferta({ desde: "2020-01-01", hasta: "2020-12-31" }));
    assert.deepEqual((await request(app).get("/v1/ofertas?restauranteId=r1")).body.data, []);
  });
  test("400 sin restauranteId; mias exige ser dueño", async () => {
    assert.equal((await request(app).get("/v1/ofertas")).status, 400);
    assert.equal((await request(app).get("/v1/ofertas/mias?restauranteId=r1").set(auth(otraEmpresa))).status, 403);
    assert.equal((await request(app).get("/v1/ofertas/mias?restauranteId=r1")).status, 401);
  });
});

describe("PUT y DELETE /v1/ofertas/:id", () => {
  test("editar sustituye los campos, no permite mover de restaurante y respeta la única activa", async () => {
    const a = (await crear(oferta())).body;
    const b = (await crear(oferta({ titulo: "Cena", activa: false }))).body;
    const editada = await request(app).put(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa)).send({ ...sinRestaurante(oferta()), titulo: "Menú nuevo", niveles: niveles([0, 5, 10, 30]) });
    assert.equal(editada.status, 200);
    assert.equal(editada.body.titulo, "Menú nuevo");
    assert.equal(editada.body.niveles[3].descuentoPct, 30);
    assert.equal((await request(app).put(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa)).send(oferta())).status, 400, "restauranteId no se acepta");
    assert.equal((await request(app).put(`/v1/ofertas/${b.id}`).set(auth(tokens.empresa)).send(sinRestaurante(oferta()))).status, 409);
  });
  test("otra empresa no puede editar ni borrar; 404 si no existe; la dueña borra", async () => {
    const a = (await crear(oferta())).body;
    assert.equal((await request(app).put(`/v1/ofertas/${a.id}`).set(auth(otraEmpresa)).send(sinRestaurante(oferta()))).status, 403);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(otraEmpresa))).status, 403);
    assert.equal((await request(app).delete("/v1/ofertas/nope").set(auth(tokens.empresa))).status, 404);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa))).status, 204);
    assert.equal((await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa))).status, 404);
  });
});

describe("una sola activa ante peticiones simultáneas (P1 de la revisión de Codex)", () => {
  const publicasR1 = async () => (await request(app).get("/v1/ofertas?restauranteId=r1")).body.data;
  const activar = (id) => request(app).put(`/v1/ofertas/${id}`).set(auth(tokens.empresa)).send(sinRestaurante(oferta()));

  test("dos altas activas a la vez: una 201, otra 409 y queda una sola pública", async () => {
    const res = await Promise.all([crear(oferta({ titulo: "A" })), crear(oferta({ titulo: "B" }))]);
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await publicasR1()).length, 1);
    assert.equal(store.get("ofertas_activas").get("r1").ofertaId, res.find((r) => r.status === 201).body.id);
  });

  test("activar a la vez dos inactivas: una 200, otra 409 y queda una sola pública", async () => {
    const a = (await crear(oferta({ titulo: "A", activa: false }))).body;
    const b = (await crear(oferta({ titulo: "B", activa: false }))).body;
    const res = await Promise.all([activar(a.id), activar(b.id)]);
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await publicasR1()).length, 1);
  });

  test("desactivar o borrar la activa libera el restaurante para otra", async () => {
    const a = (await crear(oferta({ titulo: "A" }))).body;
    const b = (await crear(oferta({ titulo: "B", activa: false }))).body;
    await request(app).put(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa)).send({ ...sinRestaurante(oferta()), activa: false });
    assert.equal(store.get("ofertas_activas").has("r1"), false);
    assert.equal((await activar(b.id)).status, 200);
    assert.equal((await request(app).delete(`/v1/ofertas/${b.id}`).set(auth(tokens.empresa))).status, 204);
    assert.equal(store.get("ofertas_activas").has("r1"), false);
    assert.equal((await crear(oferta({ titulo: "C" }))).status, 201);
  });

  test("editar la oferta que ya es la activa no choca consigo misma", async () => {
    const a = (await crear(oferta())).body;
    assert.equal((await activar(a.id)).status, 200);
    assert.equal((await activar(a.id)).status, 200);
  });

  test("un bloqueo que apunta a una oferta que ya no existe no impide activar otra", async () => {
    seed("ofertas_activas", "r1", { ofertaId: "borrada" });
    assert.equal((await crear(oferta())).status, 201);
  });
});

describe("GET /v1/ofertas/cerca (G05)", () => {
  // r1 en Madrid (40.4, -3.7). 1 grado de latitud ≈ 111 195 m.
  const R1 = { lat: 40.4, lng: -3.7 };
  const alNorte = (m) => ({ lat: R1.lat + m / 111195, lng: R1.lng });
  const cerca = (p) => request(app).get(`/v1/ofertas/cerca?lat=${p.lat}&lng=${p.lng}`);

  test("haversine y nivel alcanzado en cada franja", () => {
    assert.ok(Math.abs(logica.distanciaM(R1, alNorte(900)) - 900) < 2);
    const n = niveles();
    assert.equal(logica.nivelAlcanzado(n, 900).distancia, 1000);
    assert.equal(logica.nivelAlcanzado(n, 400).distancia, 500);
    assert.equal(logica.nivelAlcanzado(n, 50).distancia, 100);
    assert.equal(logica.nivelAlcanzado(n, 15).distancia, 20);
    assert.equal(logica.nivelAlcanzado(n, 1001), null);
  });

  test("a 900, 400, 50 y 10 m devuelve el nivel correcto; a 1500 m no aparece", async () => {
    await crear(oferta());
    for (const [m, nivel] of [[900, 1000], [400, 500], [50, 100], [10, 20]]) {
      const res = await cerca(alNorte(m));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1, `a ${m} m`);
      assert.equal(res.body.data[0].nivel.distancia, nivel, `a ${m} m`);
      assert.ok(Math.abs(res.body.data[0].distanciaM - m) <= 2);
      assert.equal(res.body.data[0].restaurante.id, "r1");
      assert.deepEqual(res.body.data[0].restaurante.coordenadas, R1);
    }
    assert.deepEqual((await cerca(alNorte(1500))).body.data, []);
  });

  test("ordena por distancia y omite inactivas, fuera de vigencia y restaurantes sin coordenadas", async () => {
    seed("restaurants", "r2", { ...store.get("restaurants").get("r2"), ownerUid: "u-emp2", coordenadas: { latitud: R1.lat + 300 / 111195, longitud: R1.lng } });
    await crear(oferta());
    await crear(oferta({ restauranteId: "r2" }), otraEmpresa);
    const res = await cerca(alNorte(250));
    assert.deepEqual(res.body.data.map((x) => x.restaurante.id), ["r2", "r1"]);
    await crear(oferta({ restauranteId: "r3" }), tokens.admin); // r3 sin coordenadas
    const id2 = res.body.data[0].oferta.id;
    await request(app).put(`/v1/ofertas/${id2}`).set(auth(otraEmpresa)).send({ ...sinRestaurante(oferta()), activa: false });
    assert.deepEqual((await cerca(alNorte(250))).body.data.map((x) => x.restaurante.id), ["r1"]);
  });

  test("una oferta activa fuera de su vigencia no aparece", async () => {
    await crear(oferta({ desde: "2020-01-01", hasta: "2020-12-31" }));
    assert.deepEqual((await cerca(alNorte(10))).body.data, []);
  });

  test("400 con lat/lng ausentes o fuera de rango", async () => {
    assert.equal((await request(app).get("/v1/ofertas/cerca")).status, 400);
    assert.equal((await request(app).get("/v1/ofertas/cerca?lat=91&lng=0")).status, 400);
    assert.equal((await request(app).get("/v1/ofertas/cerca?lat=abc&lng=0")).status, 400);
  });

  test("crear o borrar invalida la caché y la posición no se guarda en Firestore", async () => {
    assert.deepEqual((await cerca(alNorte(10))).body.data, []);
    const a = (await crear(oferta())).body;
    assert.equal((await cerca(alNorte(10))).body.data.length, 1, "la caché no esconde la oferta nueva");
    await request(app).delete(`/v1/ofertas/${a.id}`).set(auth(tokens.empresa));
    assert.deepEqual((await cerca(alNorte(10))).body.data, []);
    const colecciones = [...store.keys()];
    assert.ok(!colecciones.some((c) => /posici|ubicac|location|cerca/i.test(c)), colecciones.join(","));
  });

  test("bordes: la distancia real decide radio y nivel (±0,4 m de cada umbral)", async () => {
    await crear(oferta());
    for (const umbral of [20, 100, 500]) {
      const dentro = (await cerca(alNorte(umbral - 0.4))).body.data[0];
      const fuera = (await cerca(alNorte(umbral + 0.4))).body.data[0];
      assert.equal(dentro.nivel.distancia, umbral, `${umbral - 0.4} m`);
      assert.ok(fuera.nivel.distancia > umbral, `${umbral + 0.4} m no adelanta el nivel`);
    }
    assert.equal((await cerca(alNorte(999.6))).body.data.length, 1);
    assert.deepEqual((await cerca(alNorte(1000.4))).body.data, [], "1000,4 m queda fuera aunque redondee a 1000");
  });

  test("una carga empezada antes de desactivar no vuelve a meter la oferta en la caché", async () => {
    const { db } = require("../src/middlewares/verifyFirebaseAuth");
    const a = (await crear(oferta())).body;
    let soltar;
    const barrera = new Promise((r) => { soltar = r; });
    const original = db.collection;
    db.collection = (nombre) => {
      const c = original.call(db, nombre);
      if (nombre !== "restaurants") return c;
      return { ...c, doc: (id) => { const ref = c.doc(id); return { ...ref, get: async () => { await barrera; return ref.get(); } }; } };
    };
    try {
      const pendiente = svc.cerca(alNorte(10)); // carga en curso, parada en el restaurante
      await new Promise((r) => setImmediate(r));
      await svc.editar(a.id, { ...sinRestaurante(oferta()), activa: false }); // invalida
      soltar();
      assert.deepEqual(await pendiente, [], "la respuesta no usa la carga vieja");
    } finally { db.collection = original; }
    assert.deepEqual((await cerca(alNorte(10))).body.data, [], "y la caché tampoco");
  });

  test("dos peticiones simultáneas en frío comparten una sola carga", async () => {
    const { db } = require("../src/middlewares/verifyFirebaseAuth");
    await crear(oferta());
    let lecturas = 0;
    const original = db.collection;
    db.collection = (nombre) => {
      const c = original.call(db, nombre);
      return nombre === "ofertas_activas" ? { ...c, get: async () => { lecturas++; return c.get(); } } : c;
    };
    try {
      svc.invalidarCache();
      const [x, y] = await Promise.all([svc.cerca(alNorte(10)), svc.cerca(alNorte(10))]);
      assert.equal(x.length, 1);
      assert.equal(y.length, 1);
      assert.equal(lecturas, 1);
    } finally { db.collection = original; }
  });
});


describe("estadísticas de ofertas (contrato fase 3, para G07)", () => {
  const hoy = () => logica.hoyMadrid();
  const avisar = (id, nivel) => request(app).post(`/v1/ofertas/${id}/avisos`).send({ nivel });
  const verStats = (q, token = tokens.empresa) => request(app).get(`/v1/ofertas/estadisticas?${q}`).set(auth(token));

  test("los avisos suman por nivel en el contador del día, sin datos del usuario", async () => {
    const a = (await crear(oferta())).body;
    for (const nivel of [1000, 1000, 500, 20]) assert.equal((await avisar(a.id, nivel)).status, 204);
    const doc = store.get("ofertas_stats").get(`r1_${hoy()}`);
    assert.deepEqual(doc.avisos, { 1000: 2, 500: 1, 20: 1 });
    assert.deepEqual(Object.keys(doc).sort(), ["avisos", "fecha", "restauranteId"]);
    const res = await verStats(`restauranteId=r1&desde=${hoy()}&hasta=${hoy()}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, [{ fecha: hoy(), avisos: { 1000: 2, 500: 1, 100: 0, 20: 1 }, visitas: 0, confirmadas: 0 }]);
  });

  test("aviso: 400 con un nivel que no existe, 404 si la oferta no existe o no está activa", async () => {
    const a = (await crear(oferta())).body;
    assert.equal((await avisar(a.id, 250)).status, 400);
    assert.equal((await request(app).post(`/v1/ofertas/${a.id}/avisos`).send({ nivel: 20, uid: "x" })).status, 400, "strict");
    assert.equal((await avisar("nope", 20)).status, 404);
    const b = (await crear(oferta({ titulo: "Inactiva", activa: false }))).body;
    assert.equal((await avisar(b.id, 20)).status, 404);
  });

  test("contarVisita suma visitas y confirmadas para el módulo de visitas", async () => {
    await svc.contarVisita("r1", "visitas");
    await svc.contarVisita("r1", "visitas");
    await svc.contarVisita("r1", "confirmadas");
    const fila = (await verStats(`restauranteId=r1&desde=${hoy()}&hasta=${hoy()}`)).body.data[0];
    assert.equal(fila.visitas, 2);
    assert.equal(fila.confirmadas, 1);
    await assert.rejects(() => svc.contarVisita("r1", "otra"));
  });

  test("rango de fechas: filtra, ordena y limita a 92 días", async () => {
    seed("ofertas_stats", "r1_2026-01-05", { restauranteId: "r1", fecha: "2026-01-05", visitas: 3 });
    seed("ofertas_stats", "r1_2026-01-01", { restauranteId: "r1", fecha: "2026-01-01", avisos: { 100: 4 } });
    seed("ofertas_stats", "r1_2026-03-01", { restauranteId: "r1", fecha: "2026-03-01", visitas: 9 });
    seed("ofertas_stats", "r2_2026-01-02", { restauranteId: "r2", fecha: "2026-01-02", visitas: 7 });
    const res = await verStats("restauranteId=r1&desde=2026-01-01&hasta=2026-01-31");
    assert.deepEqual(res.body.data.map((d) => d.fecha), ["2026-01-01", "2026-01-05"]);
    assert.equal(res.body.data[0].avisos[100], 4);
    assert.equal((await verStats("restauranteId=r1&desde=2026-01-01&hasta=2026-04-03")).status, 400, "93 días contando ambos extremos");
    assert.equal((await verStats("restauranteId=r1&desde=2026-01-01&hasta=2026-04-02")).status, 200, "92 días: el máximo");
    assert.equal((await verStats("restauranteId=r1&desde=2026-02-01&hasta=2026-01-01")).status, 400);
  });

  test("permisos: solo la empresa dueña o un admin", async () => {
    const q = `restauranteId=r1&desde=${hoy()}&hasta=${hoy()}`;
    assert.equal((await request(app).get(`/v1/ofertas/estadisticas?${q}`)).status, 401);
    assert.equal((await verStats(q, tokens.cliente)).status, 403);
    assert.equal((await verStats(q, otraEmpresa)).status, 403);
    assert.equal((await verStats(q, tokens.admin)).status, 200);
  });
});
