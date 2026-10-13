const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { clearRateLimits } = require('../src/middlewares/rateLimit');

test.beforeEach(() => { seedBase(); clearRateLimits(); });
test('panel devuelve todos los tickets propios para documentos y conserva preview de 20', async () => {
  seed('restaurants', 'propio', { nombre: 'Propio', uid: 'u-emp' });
  for (let i = 0; i < 525; i++) seed('tickets', `t${i}`, { restaurantId: 'propio', createdAt: new Date(), fecha: '2026-10-13', totalPagado: 100 });
  seed('tickets', 'ajeno', { restaurantId: 'otro', createdAt: new Date(), totalPagado: 999 });
  const r = await request(app).get('/v1/dashboard/restaurant/propio').set('Authorization', `Bearer ${tokens.empresa}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.tickets.length, 525);
  assert.equal(r.body.ticketsRecientes.length, 20);
  assert.equal(r.body.tickets.reduce((n, t) => n + t.totalPagado, 0), 52500);
  assert.ok(!r.body.tickets.some(t => t.id === 'ajeno'));
});
test('los tickets completos no se exponen a otra empresa ni a un cliente', async () => {
  seed('restaurants', 'ajeno', { nombre: 'Ajeno', uid: 'otra-empresa' });
  for (const token of [tokens.empresa, tokens.cliente]) {
    const r = await request(app).get('/v1/dashboard/restaurant/ajeno').set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 403);
  }
});
