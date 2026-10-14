const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
const tokenAnterior = env.BREVO_WEBHOOK_TOKEN;
test.beforeEach(() => {
 seedBase(); clearRateLimits(); env.BREVO_WEBHOOK_TOKEN = 'test-only-webhook-token';
 seed('invitaciones', 'i1', { messageId: '<i1@brevo>', emailInvitado: 'amigo@test.local', estado: 'pendiente', emailEstado: 'enviado', createdAt: '2026-10-14T10:00:00Z' });
});
test.after(() => { env.BREVO_WEBHOOK_TOKEN = tokenAnterior; });
const url = '/v1/invite/webhook/brevo?token=test-only-webhook-token';

test('token incorrecto, ausente, repetido o servidor sin token: 401', async () => {
 for (const query of ['?token=incorrecto', '', '?token=a&token=b']) {
  const r = await request(app).post('/v1/invite/webhook/brevo' + query).send({ event: 'hard_bounce', 'message-id': '<i1@brevo>' });
  assert.equal(r.status, 401);
 }
 env.BREVO_WEBHOOK_TOKEN = '';
 assert.equal((await request(app).post(url).send({ event: 'blocked' })).status, 401);
 assert.equal(store.get('invitaciones').get('i1').emailEstado, 'enviado');
});
test('hard_bounce, invalid_email y blocked marcan inexistente por message-id', async () => {
 for (const event of ['hard_bounce', 'invalid_email', 'blocked']) {
  seed('invitaciones', 'i1', { messageId: '<i1@brevo>', estado: 'pendiente', emailEstado: 'enviado' });
  const r = await request(app).post(url).send({ event, 'message-id': '<i1@brevo>', email: 'distinto@test.local', reason: 'dato privado' });
  assert.equal(r.status, 200); assert.equal(store.get('invitaciones').get('i1').emailEstado, 'inexistente');
 }
});
test('fallback por email selecciona solo la pendiente más reciente', async () => {
 seed('invitaciones', 'reciente', { emailInvitado: 'amigo@test.local', estado: 'pendiente', createdAt: '2026-10-14T11:00:00Z', emailEstado: 'enviado' });
 seed('invitaciones', 'aceptada', { emailInvitado: 'amigo@test.local', estado: 'aceptada', createdAt: '2026-10-14T12:00:00Z', emailEstado: 'enviado' });
 const r = await request(app).post(url).send({ event: 'hard_bounce', 'message-id': '<no-encontrado>', email: ' AMIGO@test.local ' });
 assert.equal(r.status, 200); assert.equal(store.get('invitaciones').get('reciente').emailEstado, 'inexistente');
 assert.equal(store.get('invitaciones').get('i1').emailEstado, 'enviado'); assert.equal(store.get('invitaciones').get('aceptada').emailEstado, 'enviado');
});
test('eventos desconocidos o conocidos sin coincidencia devuelven 200', async () => {
 assert.equal((await request(app).post(url).send({ event: 'delivered' })).status, 200);
 assert.equal((await request(app).post(url).send({ event: 'futuro', email: null, extra: [] })).status, 200);
 assert.equal((await request(app).post(url).send({ event: 'hard_bounce', 'message-id': '<ausente>' })).status, 200);
 assert.equal(store.get('invitaciones').get('i1').emailEstado, 'enviado');
});
test('no modifica aceptadas ni esperando reservas aunque coincida message-id', async () => {
 for (const estado of ['aceptada', 'esperando_2_reservas']) {
  seed('invitaciones', 'i1', { messageId: '<i1@brevo>', estado, aceptadaPor: 'u-cli2', emailEstado: 'enviado' });
  assert.equal((await request(app).post(url).send({ event: 'blocked', 'message-id': '<i1@brevo>', email: 'amigo@test.local' })).status, 200);
  assert.equal(store.get('invitaciones').get('i1').emailEstado, 'enviado');
 }
});
test('valida el cuerpo y aplica rate limit por IP', async () => {
 assert.equal((await request(app).post(url).send({ event: 25 })).status, 400);
 clearRateLimits();
 for (let i = 0; i < 120; i++) assert.equal((await request(app).post(url).send({ event: 'futuro', email: null, extra: [] })).status, 200);
 assert.equal((await request(app).post(url).send({ event: 'futuro' })).status, 429);
});

test('message-id sin corchetes sigue identificando la invitación exacta', async () => {
 const r = await request(app).post(url).send({ event: 'hard_bounce', 'message-id': 'i1@brevo', email: 'otra@test.local' });
 assert.equal(r.status, 200); assert.equal(store.get('invitaciones').get('i1').emailEstado, 'inexistente');
});

test('el logger de peticiones nunca guarda el token de la URL del webhook', () => {
 const { logger, requestLogger } = require('../src/middlewares/errorHandler');
 const original = logger.info;
 let registrado;
 try {
  logger.info = (datos) => { registrado = datos; };
  requestLogger({ method: 'POST', url: '/v1/invite/webhook/brevo?token=secreto-no-registrar', id: 'test' }, { statusCode: 200, on: (_, fn) => fn() }, () => {});
  assert.equal(registrado.url, '/v1/invite/webhook/brevo'); assert.ok(!JSON.stringify(registrado).includes('secreto-no-registrar'));
 } finally { logger.info = original; }
});
