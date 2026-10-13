const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
const servicio = require('../src/modules/invitations/service');

test.beforeEach(() => { seedBase(); clearRateLimits(); });
test('crear, aceptar, completar dos reservas y recompensar una vez a ambos', async () => {
 const creada = await request(app).post('/v1/invite').set('Authorization', `Bearer ${tokens.cliente}`).send({email:'cli2@test.local'});
 assert.equal(creada.status,201);
 const aceptada = await request(app).post('/v1/invite/accept').set('Authorization', `Bearer ${tokens.cliente2}`).send({codigo:creada.body.codigo});
 assert.equal(aceptada.status,200);
 await servicio.onInvitadoReservaCompletada('u-cli2','r1');
 assert.equal(store.get('usuarios').get('u-cli').saldoPuntos,0);
 await servicio.onInvitadoReservaCompletada('u-cli2','r2');
 assert.equal(store.get('usuarios').get('u-cli').saldoPuntos,200);
 assert.equal(store.get('usuarios').get('u-cli2').saldoPuntos,200);
 await servicio.onInvitadoReservaCompletada('u-cli2','r2');
 assert.equal(store.get('usuarios').get('u-cli').saldoPuntos,200);
 const mias=await servicio.getMyInvites('u-cli');
 assert.equal(mias.aceptadas,1);
 assert.equal(mias.puntosTotales,200);
});
test('la misma reserva no satisface el requisito de dos reservas',async()=>{
 const c=await servicio.crearInvitacion('u-cli','cli2@test.local');
 await servicio.aceptarInvitacion(c.codigo,'u-cli2','cli2@test.local');
 await servicio.onInvitadoReservaCompletada('u-cli2','r1');
 await servicio.onInvitadoReservaCompletada('u-cli2','r1');
 assert.equal(store.get('usuarios').get('u-cli').saldoPuntos,0);
});
