const test = require('node:test');
const assert = require('node:assert/strict');
const { seedBase, seed, store, tokens } = require('./helpers/mockFirebase');
const request = require('supertest');
const app = require('../src/app');
const { clearRateLimits } = require('../src/middlewares/rateLimit');
test.beforeEach(()=>{seedBase();clearRateLimits();});
test('marcar todos afecta solo a mensajes propios y es idempotente',async()=>{
 for(let i=0;i<505;i++) seed('mensajes',`m${i}`,{uid:'u-cli',leido:false});
 seed('mensajes','ajeno',{uid:'u-cli2',leido:false});
 const r=await request(app).put('/v1/mensajes/read-all').set('Authorization',`Bearer ${tokens.cliente}`);
 assert.equal(r.status,200);assert.equal(r.body.actualizados,505);
 assert.equal(store.get('mensajes').get('ajeno').leido,false);
 const n=await request(app).get('/v1/mensajes/unread-count').set('Authorization',`Bearer ${tokens.cliente}`);
 assert.equal(n.body.count,0);
 const otra=await request(app).put('/v1/mensajes/read-all').set('Authorization',`Bearer ${tokens.cliente}`);
 assert.equal(otra.body.actualizados,0);
});
test('marcar todos exige sesión',async()=>{
 assert.equal((await request(app).put('/v1/mensajes/read-all')).status,401);
});
