const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { enviarInvitacion } = require('../src/modules/invitations/mailer');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
const config = { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_USER: 'smtp@test.local', SMTP_PASS: 'test-only', MAIL_FROM: 'MIRA <smtp@test.local>', FRONTEND_URL: 'https://mira.test/' };
const log = { warn() {} };

test('SMTP usa TLS, remitente y enlace de registro con el código', async () => {
  let options, mail;
  assert.equal(await enviarInvitacion({ email: 'amigo@test.local', codigo: 'ABC123' }, {
    config, log, createTransport: (opts) => { options = opts; return { sendMail: async (m) => { mail = m; } }; },
  }), true);
  assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.secure, true);
  assert.equal(options.auth.pass, 'test-only'); assert.equal(mail.from, config.MAIL_FROM);
  assert.equal(mail.to, 'amigo@test.local'); assert.match(mail.text, /https:\/\/mira.test\/#\/registro\?invite=ABC123/);
});

test('sin credenciales avisa sin abrir transporte; fallos SMTP no rompen', async () => {
  let avisos = 0;
  const log = { warn: () => avisos++ };
  assert.equal(await enviarInvitacion({ email: 'a@b.test', codigo: 'ABC' }, { config: {}, log, createTransport: () => assert.fail('No debe conectar') }), false);
  assert.equal(await enviarInvitacion({ email: 'a@b.test', codigo: 'ABC' }, { config, log, createTransport: () => ({ sendMail: async () => { throw new Error('SMTP'); } }) }), false);
  assert.equal(avisos, 2);
});

test('valida solo formato y el listado persistido se puede recuperar con una nueva petición', async () => {
  seedBase(); clearRateLimits();
  for (const email of ['sin-arroba', 'a@', 'a b@c.test']) {
    assert.equal((await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({ email })).status, 400);
  }
  const creada = await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({ email: ' amigo@dominio-inexistente.test ' });
  assert.equal(creada.status, 201);
  const lista = await request(app).get('/v1/invite/my').set('Authorization', `Bearer ${tokens.cliente}`);
  assert.equal(lista.status, 200); assert.equal(lista.body.enviadas[0].id, creada.body.id);
  assert.equal(lista.body.enviadas[0].emailInvitado, 'amigo@dominio-inexistente.test');
  const ajenas = await request(app).get('/v1/invite/my').set('Authorization', `Bearer ${tokens.cliente2}`);
  assert.equal(ajenas.body.enviadas.length, 0);
});

test('SMTP en 587 exige STARTTLS y la creación conserva datos aunque falle el transporte', async () => {
  let options;
  await enviarInvitacion({ email: 'a@b.test', codigo: 'ABC' }, {
    config: { ...config, SMTP_PORT: 587 }, log,
    createTransport: (opts) => { options = opts; return { sendMail: async () => {} }; },
  });
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true);
  const nodemailer = require('nodemailer');
  const { env } = require('../src/config/env');
  const original = nodemailer.createTransport;
  const antes = { ...env };
  let envios = 0;
  try {
    seedBase(); clearRateLimits();
    Object.assign(env, config);
    nodemailer.createTransport = () => ({ sendMail: async () => { envios++; throw new Error('SMTP simulado'); } });
    const creada = await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({ email: 'a@b.test' });
    assert.equal(creada.status, 201); assert.equal(envios, 1);
    const lista = await request(app).get('/v1/invite/my').set('Authorization', `Bearer ${tokens.cliente}`);
    assert.equal(lista.body.enviadas[0].id, creada.body.id);
  } finally { nodemailer.createTransport = original; Object.assign(env, antes); }
});
