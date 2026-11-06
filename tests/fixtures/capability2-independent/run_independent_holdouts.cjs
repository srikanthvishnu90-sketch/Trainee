'use strict';
// Independent synthetic holdouts. No provider, browser, network, real profile
// or original private evaluator case is used. Frozen rules are read unchanged.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const manifest=JSON.parse(fs.readFileSync('INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json','utf8'));
const R=require('./source/packages/domain/154-career-recommendations.js'),P=require('./source/packages/domain/122-career-profile.js');
const O=require('./source/packages/domain/130-career-onboarding.js');
const {CareerHost}=require('/workspace/upmore-muse-reliability-20261015/candidate/supabase/functions/_shared/career_host.js');
const deps=Object.fromEntries([['CareerAccess','120-career-access.js'],['CareerOnboarding','130-career-onboarding.js'],['CareerRouter','142-career-router.js'],['CareerDoorstep','141-career-doorstep.js'],['CareerReply','140-career-reply.js'],['CareerContainment','143-career-containment.js']].map(([k,p])=>[k,require('./source/packages/domain/'+p)]));
const host=CareerHost.createCareerHost(deps),now=Date.parse(manifest.now),copy=x=>structuredClone(x),results=[];
for(const c of manifest.cases){O._resetCorrectionStore();let observed;try{
 const profile=copy(c.profile||{});
 if(c.kind==='evidence_not_present'||c.kind==='evidence_present'){
  observed=R.evidence(profile,c.skill);if(c.kind==='evidence_present')assert.equal(observed.status,'evidence_present');else assert.notEqual(observed.status,'evidence_present');
 }else if(c.kind==='legacy_ingest_id'){
  const before=JSON.stringify(profile);const out=R.ingestResume({profile,now},c.resume);observed={original_unchanged:before===JSON.stringify(profile),existing_facts:out.profile.facts.filter(f=>f.fact_id==='LEGACY-STABLE-901'),cited_fact_ids:R.planPaths({profile:out.profile}).factIds};assert.equal(observed.original_unchanged,true);assert.ok(observed.cited_fact_ids.includes('LEGACY-STABLE-901'),'legacy fact_id silently changed in returned profile');
 }else if(['no_openings','one_opening'].includes(c.kind)){
  observed=R.planPaths({profile,postings:copy(c.postings),now}).currentOpenings;assert.equal(observed.openings.length,c.kind==='one_opening'?1:0);
 }else if(c.kind==='freshness_false'){observed=R.freshness(c.posting,now);assert.equal(observed.current,false);}
 else if(['named_skill_route','budget_route','posting_requirement_route'].includes(c.kind)){
  const ctx=host.createTurnCtx({userId:'independent-synthetic-owner',threadId:'independent-synthetic-thread',profile,postings:[],now});if(c.posting)ctx.posting=copy(c.posting);const out=host.runTurn(c.message,ctx);observed={intent:out.intent,reply:out.reply,payload:out.result?.artifact,contained:out.contained};assert.equal(out.contained,false);
  if(c.kind==='budget_route')assert.equal(observed.payload?.totalMinutesPerWeek,c.expected_minutes);else assert.ok(observed.payload?.gaps?.some(g=>g.skill.toLowerCase()===c.skill.toLowerCase()),'explicit named skill lost by actual route');
 }else if(c.kind==='inplace_correction'){
  P.updateFact(profile,c.fact_id,{text:c.corrected_text});observed=R.evidence(profile,c.skill);assert.notEqual(observed.status,'evidence_present');
 }else if(c.kind==='cross_owner_correction'){
  const make=()=>P.createProfile({id:'shared-default-profile',facts:[{id:'F-001',kind:'education',title:'Education: graduation date conflict',text:'resume-old.txt says 2027; resume-new.txt says 2028',needs_confirmation:true}]});
  const a=make(),b=make();const correction=O.handleChat('Use the new resume; the old resume is wrong',{profile:a,userId:c.user_a,now});assert.equal(correction.ok,true);const ctx=host.createTurnCtx({userId:c.user_b,threadId:'other-thread',profile:b,now});host.runTurn('Based on my resume, recommend roles',ctx);observed={owner_a:correction.changes,owner_b_fact:ctx.profile.facts[0],owner_b_corrections:ctx.profile.profile_corrections,owner_b_sources:ctx.profile.resume_sources};assert.equal(ctx.profile.facts[0].needs_confirmation,true,'another owner inherited a correction from module-global cache');
 }else throw Error('Unknown holdout '+c.kind);
 results.push({id:c.id,rule:c.rule,status:'PASS',observed});
 }catch(e){results.push({id:c.id,rule:c.rule,status:'FAIL',observed,error:e.message});}}
O._resetCorrectionStore();const diversity=manifest.coverage_observations.map(c=>({id:c.id,label:c.label,out:R.planPaths({profile:copy(c.profile),now})}));
const report={cohort:manifest.cohort,source_sha:manifest.source_sha,manifest_sha256:crypto.createHash('sha256').update(fs.readFileSync('INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json')).digest('hex'),pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length,results,diversity,actual_paid_calls:0,actual_browser_calls:0,actual_network_calls:0,production_mutations:0,scope:'source modules + atomic host seam; not real HTTP/database/live integration; no quality or launch score'};
fs.writeFileSync('evidence/INDEPENDENT_HOLDOUT_RESULTS_v1.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({cohort:report.cohort,pass:report.pass,fail:report.fail,results:results.map(r=>({id:r.id,status:r.status,error:r.error}))},null,2));
