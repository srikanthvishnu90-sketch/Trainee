'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const M=require('../packages/domain/130-career-onboarding.js'),F=require('./helpers/resume-supersession-fixture.cjs');
const correct=(p,text,at='2026-10-16T12:00:00Z')=>M.applyProfileCorrection(p,F.CORRECT,text===undefined?{now:at}:{resumeTexts:{'resume-new.txt':text},now:at});
const unchanged=(p,ctx)=>{const before=F.copy(p),r=M.applyProfileCorrection(p,F.CORRECT,ctx);assert.equal(r.ok,false);assert.deepEqual(p,before,'a refused source must change no fact, audit, annotation, source record or version');return r;};
test('reported CP10: confirmed 2028 can explicitly become 2033 then 2030, preserving fact identity and prior active audit',()=>{
 const p=F.profile(),id=p.facts[0].id;assert.equal(correct(p).ok,true);assert.equal(p.constraints.graduationDate,'2028');
 for(const [before,year]of [['2028','2033'],['2033','2030']]){const r=correct(p,F.NEW(year));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(p.constraints.graduationDate,year);assert.equal(p.facts[0].id,id);assert.equal(r.changes[0].from,before);assert.equal(r.changes[0].to,year);assert.equal(p.facts[0].resolution.value,year);}
 assert.equal(p.fact_version,3);assert.equal(p.profile_corrections.length,3);assert.match(p.facts[0].text,/Resolved by your instruction to use the new resume: 2030\./);assert.doesNotMatch(p.facts[0].text,/new resume: (?:2028|2033)\./);
});
test('explicit current source wins over unresolved historical old/new labels',()=>{const p=F.profile();const r=correct(p,F.NEW('2033'));assert.equal(r.ok,true);assert.equal(p.constraints.graduationDate,'2033');assert.equal(r.changes[0].from,'2027');});
for(const [box,key]of [['resumeTexts','new'],['resumeTexts','newText'],['resumeSources','resume-new.txt']])test(`existing explicit source alias ${box}.${key} can supersede a confirmed fact`,()=>{
 const p=F.profile();correct(p);const r=M.applyProfileCorrection(p,F.CORRECT,{[box]:{[key]:F.NEW('2033')}});assert.equal(r.ok,true);assert.equal(p.constraints.graduationDate,'2033');
});
test('an initially confirmed education record can accept an explicit new date',()=>{const p=F.profile();p.facts[0].needs_confirmation=false;p.facts[0].text='B.S., Synthetic University, graduating 2027.';assert.equal(correct(p,F.NEW('2033')).ok,true);assert.equal(p.constraints.graduationDate,'2033');});
test('current explicit source is idempotent across JSON reload, with no version or audit bump',()=>{
 const p=F.profile();assert.equal(correct(p,F.NEW('2028')).ok,true);const saved=F.copy(p),r=correct(p,F.NEW('2028'));assert.equal(r.ok,true);assert.equal(r.code,'already_current');assert.deepEqual(p,saved);
 const loaded=F.copy(p);assert.equal(correct(loaded,F.NEW('2028')).code,'already_current');assert.deepEqual(loaded,saved);
});
test('a previously adopted, superseded source cannot replay after fresh profile reload',()=>{
 const p=F.profile(),old=F.NEW('2028');assert.equal(correct(p,old).ok,true);assert.equal(correct(p,F.NEW('2033')).ok,true);
 const loaded=F.copy(p),r=unchanged(loaded,{resumeTexts:{new:old}});assert.equal(r.code,'stale_resume_source');assert.equal(loaded.constraints.graduationDate,'2033');
});
test('adopted source fingerprint is owner-profile metadata, not a global correction store',()=>{
 const p=F.profile(),text=F.NEW('2033')+'\nSynthetic Unicode résumé.';assert.equal(correct(p,text).ok,true);const sha=crypto.createHash('sha256').update(text).digest('hex');assert.equal(p.profile_corrections[0].source_sha256,sha);assert.equal(p.resume_sources.active_sha256,sha);assert.deepEqual(M.exportCorrectionStore(),[]);assert.equal(M.restoreCorrectionStore([{key:p.id,graduationDate:'2099'}]),0);
});
for(const [name,ctx]of Object.entries({
 'missing date':{resumeTexts:{new:'A new synthetic resume with no graduation date.'}},
 'empty new source':{resumeTexts:{new:''}},
 'old source only':{resumeTexts:{'resume-old.txt':F.NEW('2026')}},
 'conflicting aliases':{resumeTexts:{new:F.NEW('2033'),'resume-new.txt':F.NEW('2034')}},
 'conflicting source boxes':{resumeTexts:{new:F.NEW('2033')},resumeSources:{new:F.NEW('2034')}},
 'multiple graduation dates':{resumeTexts:{new:F.NEW('2033')+'\nAnother degree, graduating 2034.'}},
 'structured unowned source is not text':{resumeTexts:{new:{ownerId:F.OWNERS[1],text:F.NEW('2033')}}}
}))test('ambiguous/stale explicit source never falls back to old labels: '+name,()=>{unchanged(F.profile(),ctx);});
test('multiple education targets cannot all receive one unbound graduation correction',()=>{const p=F.profile();p.facts.push({...F.copy(p.facts[0]),id:'OTHER-EDUCATION'});unchanged(p,{resumeTexts:{new:F.NEW('2033')}});});
test('an ambiguous education update cannot partially confirm another employment conflict',()=>{
 const p=F.profile();p.facts.push({id:'EMPLOYMENT',kind:'experience',title:'Engineer, TESTCO — dates',needs_confirmation:true,text:'resume-old.txt says TESTCO 2010-2011; resume-new.txt says TESTCO 2012-2013'});
 unchanged(p,{resumeTexts:{new:F.NEW('2033')+'\nAnother degree graduating 2034.\nTESTCO 2018-2019'}});
});
test('repeat employment-date corrections replace the active range annotation and audit the previous range',()=>{
 const p=F.profile();p.facts=[{id:'EMPLOYMENT',kind:'experience',title:'Engineer, TESTCO — dates',needs_confirmation:true,text:'resume-old.txt says TESTCO 2010-2011; resume-new.txt says TESTCO 2012-2013'}];
 assert.equal(correct(p).ok,true);assert.equal(correct(p,'Experience\nTESTCO 2018-2019').ok,true);assert.equal(p.facts[0].start,'2018');assert.equal(p.facts[0].end,'2019');assert.equal(p.profile_corrections[1].changes[0].from,'2012-2013');assert.doesNotMatch(p.facts[0].title,/resolved: 2012-2013/);assert.equal((p.facts[0].title.match(/resolved:/g)||[]).length,1);
});
test('one organization/date pair cannot silently overwrite two distinct employment facts',()=>{
 const p=F.profile();p.facts=['Engineer','Manager'].map((role,i)=>({id:'JOB-'+i,kind:'experience',title:role+', TESTCO — dates',needs_confirmation:true,text:'resume-old.txt says TESTCO 2010-2011; resume-new.txt says TESTCO 2012-2013'}));
 unchanged(p,{resumeTexts:{new:'Experience\nTESTCO 2018-2019'}});
});
for(const message of ['Suppose I say use the new resume.','What does "use the new resume" mean?','"Use the new resume"','Use the new resume if the date is verified.'])test('non-direct correction text cannot mutate a profile: '+message,()=>{
 const p=F.profile(),before=F.copy(p);M.handleChat(message,{profile:p,resumeTexts:{new:F.NEW('2033')}});assert.deepEqual(p,before);
});
test('without a newly selected source, confirmed history remains immutable on correction/read/legacy replay',()=>{
 const p=F.profile();correct(p);const saved=F.copy(p);assert.equal(correct(p).ok,false);M.handleChat(F.RECALL,{profile:p,resumeTexts:{new:F.NEW('2033')}});assert.equal(M.applyPersistedCorrections(p),false);assert.deepEqual(p,saved);
});
