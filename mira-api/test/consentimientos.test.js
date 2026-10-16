const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { seedBase, tokens, store, encodeToken } = require('./helpers/mockFirebase');
const app = require('../src/app');
const a = { estado: 'aceptado', version: 1, fecha: '2026-10-16T08:00:00.000Z' };
const b = { estado: 'rechazado', version: 1000, fecha: '2026-10-16T10:01:00+02:00' };
const put = (body, token = tokens.cliente) => request(app).put('/v1/users/me').set('Authorization', `Bearer ${token}`).send(body);
const get = (token = tokens.cliente) => request(app).get('/v1/users/me').set('Authorization', `Bearer ${token}`);
beforeEach(seedBase);

test('GET devuelve {} con perfil o sin él; no crea documento; PUT crea el perfil', async () => {
  assert.deepEqual((await get()).body.consentimientos, {});
  const token = encodeToken({ uid: 'nuevo' });
  assert.deepEqual((await get(token)).body.consentimientos, {});
  assert.equal(store.get('usuarios').has('nuevo'), false);
  assert.equal((await put({ consentimientos: { ubicacion: a } }, token)).status, 200);
  assert.deepEqual((await get(token)).body.consentimientos, { ubicacion: a });
});

test('merge en ambas direcciones, repetición, mapa vacío y otros campos conservan decisiones y cookies', async () => {
  const cookies = { necesarias: true, marketing: false, timestamp: a.fecha };
  assert.equal((await put({ consentimientoCookies: cookies, consentimientos: { ubicacion: a } })).status, 200);
  assert.equal((await put({ consentimientos: { notificaciones: b } })).status, 200);
  assert.deepEqual((await get()).body.consentimientos, { ubicacion: a, notificaciones: b });
  for (const body of [{ consentimientos: { ubicacion: b } }, { consentimientos: { ubicacion: b } }, { consentimientos: {} }, { nombre: 'Ana' }]) {
    assert.equal((await put(body)).status, 200);
  }
  const res = await get();
  assert.deepEqual(res.body.consentimientos, { ubicacion: b, notificaciones: b });
  assert.deepEqual(res.body.consentimientoCookies, cookies);
  assert.equal(res.body.nombre, 'Ana');
});

test('escrituras concurrentes de campos distintos no se pisan', async () => {
  const responses = await Promise.all([put({ consentimientos: { ubicacion: a } }), put({ consentimientos: { notificaciones: b } })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.deepEqual((await get()).body.consentimientos, { ubicacion: a, notificaciones: b });
});

for (const invalid of [null, [], 'aceptado', {},
  { ...a, estado: 'pendiente' }, { ...a, version: 0 }, { ...a, version: 1001 },
  { ...a, version: 1.5 }, { ...a, version: '1' }, { ...a, fecha: 'ayer' },
  { ...a, fecha: '2026-02-30T08:00:00Z' }, { ...a, fecha: '2026-10-16' },
  ...Object.keys(a).map(k => Object.fromEntries(Object.entries(a).filter(([key]) => key !== k))),
]) {
  test(`consentimiento inválido da 400: ${JSON.stringify(invalid)}`, async () => {
    for (const campo of ['ubicacion', 'notificaciones']) {
      const res = await put({ consentimientos: { [campo]: invalid } });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'VALIDATION_ERROR');
    }
    assert.deepEqual((await get()).body.consentimientos, {});
  });
}
for (const body of [
  { consentimientos: null }, { consentimientos: [] }, { desconocido: true },
  { uid: 'u-cli2', consentimientos: { ubicacion: a } }, { consentimientos: { cookies: a } },
  { consentimientos: { ubicacion: { ...a, lat: 41 } } },
  { consentimientos: { notificaciones: { ...a, uid: 'u-cli2' } } },
]) {
  test(`body desconocido o inválido da 400: ${JSON.stringify(body)}`, async () => {
    assert.equal((await put(body)).status, 400);
    assert.deepEqual((await get()).body.consentimientos, {});
  });
}

test('aislamiento: cada Bearer lee y escribe solo su perfil', async () => {
  await put({ consentimientos: { ubicacion: a } });
  assert.deepEqual((await get(tokens.cliente2)).body.consentimientos, {});
  await put({ consentimientos: { notificaciones: b } }, tokens.cliente2);
  assert.deepEqual((await get()).body.consentimientos, { ubicacion: a });
  assert.deepEqual((await get(tokens.cliente2)).body.consentimientos, { notificaciones: b });
  assert.equal((await put({ uid: 'u-cli', consentimientos: { ubicacion: b } }, tokens.cliente2)).status, 400);
  assert.deepEqual((await get()).body.consentimientos, { ubicacion: a });
  for (const method of ['get', 'put']) {
    assert.equal((await request(app)[method]('/v1/users/u-cli').set('Authorization', `Bearer ${tokens.cliente2}`).send({ consentimientos: { ubicacion: b } })).status, 404);
  }
});

test('GET y PUT rechazan falta de Bearer o token inválido', async () => {
  for (const method of ['get', 'put']) {
    assert.equal((await request(app)[method]('/v1/users/me').send({})).status, 401);
    assert.equal((await request(app)[method]('/v1/users/me').set('Authorization', `Bearer ${tokens.invalid}`).send({})).status, 401);
  }
});
