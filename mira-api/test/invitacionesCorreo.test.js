const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { enviarInvitacion } = require('../src/modules/invitations/mailer');
const { env } = require('../src/config/env');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
const config = { BREVO_API_KEY: 'test-only-api-key', MAIL_FROM: 'MIRA <mira@test.local>', FRONTEND_URL: 'https://mira.test/' };
const log = { warn() {} };

test('Brevo recibe POST HTTPS, api-key, destinatario y enlace/código en texto y HTML', async () => {
 let url, options;
 const envio = await enviarInvitacion({ email: 'amigo@test.local', codigo: 'ABC123' }, {
  config, log, fetchImpl: async (u, opts) => { url = u; options = opts; return { ok: true, json: async () => ({ messageId: '<id@brevo>' }) }; },
 });
 assert.deepEqual(envio, { emailEstado: 'enviado', messageId: '<id@brevo>' });
 assert.equal(url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(options.method, 'POST');
 assert.equal(options.headers['api-key'], config.BREVO_API_KEY); assert.equal(options.headers['Content-Type'], 'application/json');
 assert.ok(options.signal instanceof AbortSignal);
 const body = JSON.parse(options.body);
 assert.deepEqual(body.sender, { name: 'MIRA', email: 'mira@test.local' });
 assert.deepEqual(body.to, [{ email: 'amigo@test.local' }]); assert.equal(body.subject, 'Te han invitado a MIRA');
 for (const content of [body.textContent, body.htmlContent]) {
  assert.ok(content.includes('https://mira.test/#/registro?invite=ABC123')); assert.ok(content.includes('ABC123'));
 }
});

test('sin clave o remitente avisa sin llamar a fetch', async () => {
 let avisos = 0;
 for (const config of [{}, { BREVO_API_KEY: 'test-only' }]) {
  assert.deepEqual(await enviarInvitacion({ email: 'a@b.test', codigo: 'ABC' }, { config, log: { warn: () => avisos++ }, fetchImpl: () => assert.fail('No debe conectar') }), { emailEstado: 'no_enviado', messageId: null });
 }
 assert.equal(avisos, 2);
});

test('error HTTP, red o respuesta sin messageId: no_enviado y logs sin clave/cuerpo', async () => {
 const avisos = [];
 for (const fetchImpl of [
  async () => ({ ok: false, status: 401, json: () => assert.fail('No leer errores de Brevo') }),
  async () => { throw new Error('secreto del proveedor'); },
  async () => ({ ok: true, json: async () => ({}) }),
 ]) {
  assert.equal((await enviarInvitacion({ email: 'a@b.test', codigo: 'ABC' }, { config, log: { warn: (...v) => avisos.push(v) }, fetchImpl })).emailEstado, 'no_enviado');
 }
 assert.equal(avisos.length, 3); assert.ok(!JSON.stringify(avisos).includes(config.BREVO_API_KEY));
 assert.ok(!JSON.stringify(avisos).includes('secreto del proveedor'));
});

test('creación persiste messageId/estado, incluso cuando Brevo falla; lista recuperable', async () => {
 const antes = { ...env }, fetchOriginal = globalThis.fetch;
 try {
  for (const exito of [true, false]) {
   seedBase(); clearRateLimits(); Object.assign(env, config);
   globalThis.fetch = async () => ({ ok: exito, status: exito ? 201 : 500, json: async () => ({ messageId: '<id@brevo>' }) });
   const creada = await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({ email: ' Amigo@dominio-inexistente.test ' });
   assert.equal(creada.status, 201); assert.equal(creada.body.emailEstado, exito ? 'enviado' : 'no_enviado');
   assert.equal(creada.body.messageId, exito ? '<id@brevo>' : null);
   const lista = await request(app).get('/v1/invite/my').set('Authorization', `Bearer ${tokens.cliente}`);
   assert.equal(lista.status, 200); assert.equal(lista.body.enviadas[0].id, creada.body.id);
   assert.equal(lista.body.enviadas[0].emailEstado, creada.body.emailEstado);
   assert.equal(store.get('invitaciones').get(creada.body.id).messageId, creada.body.messageId);
  }
 } finally { globalThis.fetch = fetchOriginal; Object.assign(env, antes); }
});

test('HTML escapa el código y admite MAIL_FROM como email simple', async () => {
 let body;
 await enviarInvitacion({ email: 'a@b.test', codigo: '<script>&' }, { config: { ...config, MAIL_FROM: 'mira@test.local' }, log, fetchImpl: async (_, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ messageId: '<id>' }) }; } });
 assert.deepEqual(body.sender, { email: 'mira@test.local' }); assert.ok(!body.htmlContent.includes('<script>'));
 assert.ok(body.htmlContent.includes('&lt;script&gt;&amp;'));
});

test('un rebote recibido durante el envío no se sobrescribe al guardar messageId', async () => {
 const antes = { ...env }, fetchOriginal = globalThis.fetch;
 try {
  seedBase(); clearRateLimits(); Object.assign(env, config);
  globalThis.fetch = async () => {
   await require('../src/modules/invitations/service').procesarEventoBrevo({ event: 'hard_bounce', email: 'amigo@test.local' });
   return { ok: true, json: async () => ({ messageId: '<rapido@brevo>' }) };
  };
  const r = await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({ email: 'amigo@test.local' });
  assert.equal(r.status, 201); assert.equal(r.body.emailEstado, 'inexistente'); assert.equal(r.body.messageId, '<rapido@brevo>');
 } finally { globalThis.fetch = fetchOriginal; Object.assign(env, antes); }
});
