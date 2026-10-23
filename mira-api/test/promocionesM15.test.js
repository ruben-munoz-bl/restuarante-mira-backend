const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const body = { restauranteId: 'r1', fechaInicio: '2020-01-01', fechaFin: '2099-01-01', presupuestoTotal: 100 };
const post = (token = tokens.empresa) => request(app).post('/v1/promotions').set('Authorization', `Bearer ${token}`).send(body);
const put = (cambios, token = tokens.empresa, id = 'p1') => request(app).put(`/v1/promotions/${id}`).set('Authorization', `Bearer ${token}`).send(cambios);
test.beforeEach(() => {
 seedBase(); seed('restaurants', 'r1', {...store.get('restaurants').get('r1'), ownerUid: 'u-emp'});
 seed('promociones', 'p1', {...body, estado: 'activa', gastoAcumulado: 20, clicks: 5});
});
test('PUT dueño/admin: edita solo campos permitidos y conserva contadores', async () => {
 const r = await put({fechaFin:'2099-02-01', presupuestoTotal:200, estado:'pausada'});
 assert.equal(r.status,200); assert.equal(r.body.fechaFin,'2099-02-01T00:00:00.000Z');
 assert.equal(store.get('promociones').get('p1').clicks,5);
 assert.equal((await put({estado:'finalizada'},tokens.admin)).status,200);
});
test('PUT exige sesión, rol, propiedad y existencia', async () => {
 assert.equal((await request(app).put('/v1/promotions/p1').send({estado:'pausada'})).status,401);
 assert.equal((await put({estado:'pausada'},tokens.cliente)).status,403);
 seed('promociones','ajena',{...body,restauranteId:'r2',estado:'activa'});
 assert.equal((await put({estado:'pausada'},tokens.empresa,'ajena')).status,403);
 assert.equal((await put({estado:'pausada'},tokens.admin,'ajena')).status,200);
 assert.equal((await put({estado:'pausada'},tokens.admin,'ausente')).status,404);
});
test('PUT rechaza vacíos, extras, estado activa, fechas y presupuestos inválidos', async () => {
 for(const x of [{},{estado:'activa'},{uid:'otro'},{restauranteId:'r2'},{presupuestoTotal:0},{presupuestoTotal:19},{presupuestoTotal:1000001},{presupuestoTotal:'100'},{fechaFin:'2019-01-01'},{fechaFin:'2026-02-30'}]) assert.equal((await put(x)).status,400,JSON.stringify(x));
});
test('POST ignora caducadas y devuelve 409 para activas vigentes; admin puede crear', async () => {
 assert.equal((await post()).status,409);
 seed('promociones','p1',{...body,estado:'activa',fechaFin:'2020-01-02'});
 assert.equal((await post(tokens.admin)).status,201);
 assert.equal(store.get('promociones').get('p1').fechaFin,'2020-01-02');
 assert.equal((await post()).status,409);
 assert.equal((await put({fechaFin:'2099-03-01'})).status,409);
});
test('dos altas concurrentes: solo una activa; pausar permite crear la siguiente', async () => {
 await put({estado:'pausada'});
 const r=await Promise.all([post(),post()]); assert.deepEqual(r.map(x=>x.status).sort(),[201,409]);
});
