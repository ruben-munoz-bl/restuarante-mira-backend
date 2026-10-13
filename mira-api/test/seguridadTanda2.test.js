const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
test.beforeEach(()=>{
 seedBase();clearRateLimits();
 seed('restaurants','ajeno',{nombre:'Ajeno',uid:'u-otra'});
 seed('restaurants','propio',{nombre:'Propio',uid:'u-emp'});
 seed('reservas','r-ajena',{restaurantId:'ajeno',uid:'u-cli2',estado:'pendiente',fecha:'2026-12-01',hora:'13:00',comensales:2});
 seed('mensajes','m-ajeno',{uid:'u-cli2',leido:false});
 seed('tickets','t-ajeno',{restaurantId:'ajeno',uid:'u-cli2',totalPagado:80});
 seed('promociones','p-ajena',{restauranteId:'ajeno',views:10,clicks:1});
});
test('un cliente no puede marcar un mensaje ajeno',async()=>{
 const r=await request(app).put('/v1/mensajes/m-ajeno/read').set('Authorization',`Bearer ${tokens.cliente}`);
 assert.equal(r.status,403);assert.equal(store.get('mensajes').get('m-ajeno').leido,false);
});
for(const [method,path,body] of [
 ['put','/v1/dashboard/restaurant/ajeno',{nombre:'Robado'}],
 ['put','/v1/dashboard/reservations/r-ajena/status',{status:'cancelada'}],
 ['post','/v1/dashboard/reservations/r-ajena/confirm-attendance',{}],
 ['post','/v1/dashboard/reservations/r-ajena/mark-no-show',{}],
 ['post','/v1/dashboard/reservations/r-ajena/ticket',{totalPagado:80}],
 ['put','/v1/reservations/r-ajena/complete',{}],
 ['post','/v1/reservations/r-ajena/ticket',{totalPagado:80}],
 ['get','/v1/tickets/t-ajeno',undefined],
 ['get','/v1/promotions/p-ajena/stats',undefined],
 ['post','/v1/promotions',{restauranteId:'ajeno',fechaInicio:'2026-12-01',fechaFin:'2026-12-02',presupuestoTotal:100}],
]) test(`empresa no accede a ${method} ${path} de otro restaurante`,async()=>{
 let r=request(app)[method](path).set('Authorization',`Bearer ${tokens.empresa}`);if(body)r=r.send(body);
 assert.equal((await r).status,403);
});
test('usuario no se apropia de un restaurante cambiando su email de perfil',async()=>{
 seed('restaurants','email-ajeno',{nombre:'Otro',email:'dueno@test.local'});
 seed('usuarios','u-emp',{tipo:'empresa',email:'dueno@test.local'});
 const r=await request(app).get('/v1/dashboard/restaurant/email-ajeno').set('Authorization',`Bearer ${tokens.empresa}`);
 assert.equal(r.status,403);
});
test('editar restaurante propio valida y no acepta asignar dueño',async()=>{
 const r=await request(app).put('/v1/dashboard/restaurant/propio').set('Authorization',`Bearer ${tokens.empresa}`).send({nombre:'Nuevo',uid:'u-atacante'});
 assert.equal(r.status,200);assert.equal(store.get('restaurants').get('propio').uid,'u-emp');
});
test('respuestas de error no exponen detalles internos',async()=>{
 const {errorHandler}=require('../src/middlewares/errorHandler');let respuesta;
 errorHandler(new Error('secret credentials /internal/path'),{headers:{}},{status(){return this;},json(body){respuesta=body;}},()=>{});
 assert.equal(respuesta.message,'Error interno');
});

test('ruta alternativa de edición de restaurantes exige rol y pertenencia', async () => {
 const r = await request(app).put('/v1/restaurants/ajeno').set('Authorization', `Bearer ${tokens.cliente}`).send({nombre:'Robado'});
 assert.equal(r.status,403);
 assert.equal(store.get('restaurants').get('ajeno').nombre,'Ajeno');
});
test('empresa puede editar un restaurante propio y admin uno ajeno', async () => {
 for(const [id,token] of [['propio',tokens.empresa],['ajeno',tokens.admin]]){
  const r=await request(app).put(`/v1/dashboard/restaurant/${id}`).set('Authorization',`Bearer ${token}`).send({nombre:'Actualizado'});
  assert.equal(r.status,200);
 }
});
test('contacto público tiene límite de frecuencia', async () => {
 for(let i=0;i<20;i++) assert.equal((await request(app).post('/v1/contactos').send({nombre:'Prueba',email:'test@example.com',motivo:'Prueba',mensaje:'Mensaje'})).status,201);
 assert.equal((await request(app).post('/v1/contactos').send({nombre:'Prueba',email:'test@example.com',motivo:'Prueba',mensaje:'Mensaje'})).status,429);
});

test('el dueño no puede reducir su comisión pero admin sí puede modificarla',async()=>{
 const r=await request(app).put('/v1/dashboard/restaurant/propio').set('Authorization',`Bearer ${tokens.empresa}`).send({comisionPct:1});
 assert.equal(r.status,403);
 const admin=await request(app).put('/v1/dashboard/restaurant/propio').set('Authorization',`Bearer ${tokens.admin}`).send({comisionPct:8});
 assert.equal(admin.status,200);
});

test('invitación exige el email del token y una sola aceptación por usuario', async () => {
 const inv=require('../src/modules/invitations/service');
 const una=await inv.crearInvitacion('u-cli','cli2@test.local');
 const otra=await inv.crearInvitacion('u-emp','cli2@test.local');
 await assert.rejects(inv.aceptarInvitacion(una.codigo,'u-cli2',null),/para ti/);
 await inv.aceptarInvitacion(una.codigo,'u-cli2','cli2@test.local');
 await assert.rejects(inv.aceptarInvitacion(otra.codigo,'u-cli2','cli2@test.local'),/ya usada/);
 assert.equal((await inv.aceptarInvitacion(una.codigo,'u-cli2','cli2@test.local')).ok,true);
});

test('guardar la ficha completa conserva la comisión y descarta metadatos del documento', async () => {
 seed('restaurants','propio',{nombre:'Propio',uid:'u-emp',comisionPct:8,rating_yelp:4.6});
 const r=await request(app).put('/v1/dashboard/restaurant/propio').set('Authorization',`Bearer ${tokens.empresa}`).send({id:'propio',nombre:'Renombrado',uid:'u-emp',rating_yelp:4.6,comisionPct:8});
 assert.equal(r.status,200);
 const rest=store.get('restaurants').get('propio');
 assert.equal(rest.nombre,'Renombrado');assert.equal(rest.uid,'u-emp');assert.equal(rest.comisionPct,8);
});
