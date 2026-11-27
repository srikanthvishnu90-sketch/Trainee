'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const F=require('./helpers/resume-supersession-fixture.cjs');
// WO-081 port: the staged entry needs VM modules, so without them the file respawns itself with the flag (as the
// correction-authority guard does) and the gate runs it; the assertions are the branch's, unchanged.
const vm=require('node:vm'),{spawnSync}=require('node:child_process');
if(!vm.SourceTextModule){
 test('resume supersession through the exact staged entry',()=>{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--experimental-vm-modules','--test',__filename],{encoding:'utf8',env});
  assert.equal(run.status,0,run.stdout+run.stderr);
 });
}else{
test('exact staged entry commits repeated owned updates, free replay and fresh-handler recall',async t=>{
 const f=await F.fixture(t);assert.equal((await f.request()).body.meta.result_status,'completed');f.source(0,F.NEW('2033'));const saved=await f.request(0,F.CORRECT,'second');assert.equal(saved.body.meta.result_status,'completed');assert.equal(f.dbs[0].state.career.stores.profile.constraints.graduationDate,'2033');assert.equal(f.dbs[0].state.career.stores.profile.profile_corrections.length,2);assert.equal(f.dbs[0].state.career.stores.profile.profile_corrections[1].source_sha256,require('node:crypto').createHash('sha256').update(F.NEW('2033')).digest('hex'),'actual Edge-style bundle and Node use the same source fingerprint');
 assert.deepEqual(await f.request(0,F.CORRECT,'second'),saved);assert.equal(f.dbs[0].messages.length,4);const fresh=await F.fixture(t);fresh.dbs[0].state=F.copy(f.dbs[0].state);assert.match((await fresh.request(0,F.RECALL,'fresh')).body.reply,/2033/);
});
for(const collision of ['default-id','name','email'])test('repeated update source authority never crosses owners with '+collision,async t=>{
 const f=await F.fixture(t,{collision});await f.request();const text=F.NEW('2033');f.source(0,text);assert.equal((await f.request(0,F.CORRECT,'second')).body.meta.result_status,'completed');assert.match((await f.request(1,F.RECALL,'b')).body.reply,/2031/);assert.equal(f.dbs[1].state.career.stores.profile.profile_corrections,undefined);
 f.source(1,text);assert.equal((await f.request(1,F.CORRECT,'own-source')).body.meta.result_status,'completed','identical bytes adopted by A do not make B\'s owned source stale');assert.equal(f.dbs[1].state.career.stores.profile.constraints.graduationDate,'2033');assert.equal(f.dbs[1].state.career.stores.profile.profile_corrections[0].changes[0].from,'2031');assert.equal((await f.request(1,F.CORRECT,'foreign',F.THREADS[0])).status,404);
});
test('failed repeated update leaves 2028 and can retry the same key once without leaking 2033 to B',async t=>{
 const f=await F.fixture(t);await f.request();f.source(0,F.NEW('2033'));const before=F.copy(f.dbs[0].state.career.stores.profile);f.dbs[0].options.failSave=true;assert.equal((await f.request(0,F.CORRECT,'second')).status,503);assert.deepEqual(f.dbs[0].state.career.stores.profile,before);assert.match((await f.request(1,F.RECALL,'b')).body.reply,/2031/);f.dbs[0].options.failSave=false;
 const saved=await f.request(0,F.CORRECT,'second');assert.equal(saved.body.meta.result_status,'completed');assert.equal(f.dbs[0].state.career.stores.profile.constraints.graduationDate,'2033');assert.deepEqual(await f.request(0,F.CORRECT,'second'),saved);assert.equal(f.dbs[0].messages.length,4);assert.equal(f.dbs[0].state.career.stores.profile.profile_corrections.length,2);
});
test('mere source import/recall does not update a fact, and a superseded source cannot replay on a new key',async t=>{
 const f=await F.fixture(t),old=F.NEW('2028');f.source(0,old);await f.request();f.source(0,F.NEW('2033'));assert.match((await f.request(0,F.RECALL,'before')).body.reply,/2028/);assert.equal((await f.request(0,F.CORRECT,'second')).body.meta.result_status,'completed');const before=F.copy(f.dbs[0].state.career.stores.profile);
 f.source(0,old);const refused=await f.request(0,F.CORRECT,'stale');assert.equal(refused.body.meta.result_status,'blocked');assert.deepEqual(f.dbs[0].state.career.stores.profile,before);assert.match((await f.request(0,F.RECALL,'after')).body.reply,/2033/);
});
}
