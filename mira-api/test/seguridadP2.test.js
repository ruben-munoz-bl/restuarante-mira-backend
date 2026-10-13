const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const express = require('express');
const app = require('../src/app');
const { clearRateLimits, idempotency } = require('../src/middlewares/rateLimit');
test.beforeEach(() => { seedBase(); clearRateLimits(); });

test('CORS no autoriza un preview Vercel ajeno por su sufijo', async () => {
 const r=await request(app).get('/health').set('Origin','https://atacante.vercel.app');
 assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('idempotencia separa ruta, método y usuario; cuerpo distinto da conflicto', async () => {
 const local=express();let n=0;
 local.use(express.json());local.use((req,res,next)=>{req.user={uid:req.get('X-User')||'a'};next();});
 for(const method of ['post','put'])for(const ruta of ['/a','/b'])local[method](ruta,idempotency,(req,res)=>res.json({n:++n}));
 const call=(method,ruta,body,user='a')=>request(local)[method](ruta).set('Idempotency-Key','misma').set('X-User',user).send(body);
 assert.equal((await call('post','/a',{valor:1})).body.n,1);
 assert.equal((await call('post','/a',{valor:1})).body.n,1);
 assert.equal((await call('post','/b',{valor:1})).body.n,2);
 assert.equal((await call('put','/a',{valor:1})).body.n,3);
 assert.equal((await call('post','/a',{valor:1},'b')).body.n,4);
 assert.equal((await call('post','/a',{valor:2})).status,409);
 assert.equal(n,4);
});

for (const body of [
 {preferencias:'cualquiera'}, {preferencias:{vegano:'true'}}, {preferencias:{alergias:'gluten'}},
 {preferencias:{tipo:'admin'}}, {accesibilidad:{tea:'sí'}},
 {consentimientoCookies:{necesarias:false}}, {consentimientoCookies:{timestamp:'ayer'}},
 {nombre:'x'.repeat(201)}, {favoritos:Array(501).fill('r1')},
]) test(`perfil rechaza estructura/límite inválido ${JSON.stringify(body).slice(0,70)}`,async()=>{
 const r=await request(app).put('/v1/users/me').set('Authorization',`Bearer ${tokens.cliente}`).send(body);
 assert.equal(r.status,400);
});

test('perfil admite las formas que usa la web',async()=>{
 const r=await request(app).put('/v1/users/me').set('Authorization',`Bearer ${tokens.cliente}`).send({
  preferencias:{vegano:true,vegetariano:false,sinGluten:true,alergias:['gluten']},
  accesibilidad:{sillaRuedas:true,tea:false},
  consentimientoCookies:{necesarias:true,preferencias:true,analiticas:false,marketing:false,timestamp:new Date().toISOString()},
  lang:'ca', favoritos:['r1'],
 });assert.equal(r.status,200);assert.equal(store.get('usuarios').get('u-cli').preferencias.vegano,true);
});

for(const datos of [{fecha:'2099-02-31'},{fecha:'2099-13-01'},{hora:'99:00'},{hora:'13:00:00'},{comensales:'2x'},{comensales:2.5},{comensales:true},{comensales:[2]}])test(`reservas valida fecha/hora/pax ${JSON.stringify(datos)}`,async()=>{
 const r=await request(app).post('/v1/reservations').set('Authorization',`Bearer ${tokens.cliente}`).send({restaurantId:'r1',fecha:'2099-12-01',hora:'13:00',comensales:2,...datos});assert.equal(r.status,400);
});

test('reseña y evento de interacción tienen límites de longitud',async()=>{
 const review=await request(app).post('/v1/reviews').set('Authorization',`Bearer ${tokens.cliente}`).send({restauranteId:'r1',puntuacion:5,comentario:'x'.repeat(4001)});assert.equal(review.status,400);
 const inter=await request(app).post('/v1/interactions').set('Authorization',`Bearer ${tokens.cliente}`).send({restauranteId:'x'.repeat(201),tipo:'view'});assert.equal(inter.status,400);
});

test('promoción rechaza fechas inválidas, invertidas y límites financieros',async()=>{
 seed('restaurants','propio',{nombre:'Propio',uid:'u-emp'});
 for(const invalido of [{fechaInicio:'ayer'},{fechaFin:'2026-02-31'},{fechaFin:'2026-01-01'},{presupuestoTotal:1000001},{cpc:101},{puntosExtraPorReserva:-1}]){
  const r=await request(app).post('/v1/promotions').set('Authorization',`Bearer ${tokens.empresa}`).send({restauranteId:'propio',fechaInicio:'2026-10-01',fechaFin:'2026-10-31',presupuestoTotal:100,...invalido});assert.equal(r.status,400);
 }
});

test('CORS configurable autoriza solo el origen exacto y valida la configuración', async () => {
 const {crearPoliticaCors}=require('../src/middlewares/corsOrigins');
 const cors=require('cors');const politica=crearPoliticaCors('https://prod.example, https://preview-propio.vercel.app/');
 const local=express();local.use(cors({origin:(origen,cb)=>cb(null,politica(origen))}));local.get('/health',(req,res)=>res.json({ok:true}));
 for(const [origen,esperado] of [['https://prod.example',true],['https://preview-propio.vercel.app',true],['https://preview-ajeno.vercel.app',false],['https://prod.example.evil.test',false],['null',false]]){
  const r=await request(local).get('/health').set('Origin',origen);assert.equal(r.headers['access-control-allow-origin'],esperado?origen:undefined);
 }
 assert.equal((await request(local).get('/health')).status,200);
 for(const config of ['https://*.vercel.app','https://prod.example/path','https://user:pass@prod.example','ftp://prod.example'])assert.throws(()=>crearPoliticaCors(config));
});
test('idempotencia acepta el mismo cuerpo con claves en otro orden y no cachea errores', async () => {
 const local=express();let n=0;local.use(express.json());local.use((req,res,next)=>{req.user={uid:'orden'};next();});
 local.post('/orden',idempotency,(req,res)=>res.json({n:++n}));
 const a=await request(local).post('/orden').set('Idempotency-Key','orden').send({a:1,b:{x:2,y:3}});
 const b=await request(local).post('/orden').set('Idempotency-Key','orden').send({b:{y:3,x:2},a:1});assert.equal(a.body.n,b.body.n);
 let intento=0;local.post('/error',idempotency,(req,res)=>{intento++;res.status(intento===1?500:200).json({intento});});
 assert.equal((await request(local).post('/error').set('Idempotency-Key','error').send({})).status,500);
 assert.equal((await request(local).post('/error').set('Idempotency-Key','error').send({})).body.intento,2);
});
test('esquemas admiten fecha bisiesta y rechazan horas y arrays fuera de dominio', () => {
 const {fechaCalendario,horaReserva,preferencias}=require('../src/middlewares/inputSchemas');
 assert.equal(fechaCalendario.safeParse('2028-02-29').success,true);
 assert.equal(fechaCalendario.safeParse('2026-02-29').success,false);
 assert.equal(horaReserva.safeParse('23:59').success,true);
 assert.equal(horaReserva.safeParse('24:00').success,false);
 assert.equal(preferencias.safeParse({alergias:['no-reconocida']}).success,false);
});
test('validación admite promoción vigente y reserva con comensales numéricos como string',async()=>{
 seed('restaurants','propio',{nombre:'Propio',uid:'u-emp'});
 const promo=await request(app).post('/v1/promotions').set('Authorization',`Bearer ${tokens.empresa}`).send({restauranteId:'propio',fechaInicio:'2026-10-01',fechaFin:'2026-10-31',presupuestoTotal:100,cpc:0.2,puntosExtraPorReserva:20});assert.equal(promo.status,201);
 const reserva=await request(app).post('/v1/reservations').set('Authorization',`Bearer ${tokens.cliente}`).send({restaurantId:'r1',fecha:'2099-12-01',hora:'13:00',comensales:'2'});assert.equal(reserva.status,201);
});
