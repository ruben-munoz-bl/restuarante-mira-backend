const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { clearRateLimits } = require('../src/middlewares/rateLimit');

test.beforeEach(() => {
  seedBase(); clearRateLimits();
  seed('contactos', 'c-resolucion', { estado: 'pendiente', uid: 'u1' });
});

const datos = { propuestaResolucion: ' Contactar al local ', solucion: ' Abono confirmado ', encargado: ' Ana ' };

test('resolver guarda los tres campos y el estado en la misma actualización', async () => {
  const r = await request(app).put('/v1/contactos/c-resolucion/resolve').set('Authorization', `Bearer ${tokens.admin}`).send(datos);
  assert.equal(r.status, 200);
  const c = store.get('contactos').get('c-resolucion');
  assert.equal(c.estado, 'resuelta');
  assert.equal(c.propuestaResolucion, 'Contactar al local');
  assert.equal(c.solucion, 'Abono confirmado');
  assert.equal(c.encargado, 'Ana');
});

test('cada campo es obligatorio y rechaza espacios sin resolver', async () => {
  for (const campo of Object.keys(datos)) {
    for (const valor of [undefined, '   ']) {
      const r = await request(app).put('/v1/contactos/c-resolucion/resolve').set('Authorization', `Bearer ${tokens.admin}`).send({ ...datos, [campo]: valor });
      assert.equal(r.status, 400);
      assert.equal(store.get('contactos').get('c-resolucion').estado, 'pendiente');
    }
  }
});

test('resolver exige permisos de administrador', async () => {
  const r = await request(app).put('/v1/contactos/c-resolucion/resolve').send(datos);
  assert.equal(r.status, 401);
  assert.equal(store.get('contactos').get('c-resolucion').estado, 'pendiente');
});
