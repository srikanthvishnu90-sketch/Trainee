"use strict";
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
let server,base,heldResponse,onHeld;const receipts=[];const root=fs.mkdtempSync(path.join(os.tmpdir(),'upmore-apply-cli-test-'));
const form=unknown=>`<!doctype html><h1>TEST role</h1><form method="post" action="/submit" enctype="multipart/form-data"><label for="first">First name</label><input name="first_name" id="first" required><label for="last">Last name</label><input name="last_name" id="last" required><label for="email">Email</label><input name="email" type="email" id="email" required><label for="resume">Resume</label><input type="file" id="resume" name="resume" required>${unknown?'<label for="unknown">Favorite programming language</label><input id="unknown" name="unknown" required>':''}<button type="submit">Submit application</button></form>`;
before(async()=>{server=http.createServer(async(req,res)=>{
 if(req.method==='POST'){const parts=[];for await(const chunk of req)parts.push(chunk);const data=await new Response(Buffer.concat(parts),{headers:{'content-type':req.headers['content-type']}}).formData();const file=data.get('resume');receipts.push({first:data.get('first_name'),last:data.get('last_name'),work:data.get('work_authorization'),sha:file?crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'):null});if(onHeld){heldResponse=res;const f=onHeld;onHeld=null;f();return;}res.writeHead(req.url==='/error-submit'?503:200,{'Content-Type':'text/html'}).end(req.url==='/error-submit'?'<h1>Response unavailable</h1>':'<h1>Thank you for applying</h1><p>Application received. Confirmation number: TEST-12345.</p>');return;}
 if(req.url==='/redirect'){res.writeHead(302,{Location:'https://example.invalid/never-requested'}).end();return;}
 // The employer's site refusing for load at the page itself (owner rule: back off, then RESUME): 503 with no Retry-After,
 // 503 with one, 429 with none.
 if(req.url==='/busy-503'){res.writeHead(503,{'Content-Type':'text/html'}).end('<h1>Service Unavailable</h1>');return;}
 if(req.url==='/busy-503-ra'){res.writeHead(503,{'Content-Type':'text/html','Retry-After':'7'}).end('<h1>Service Unavailable</h1>');return;}
 if(req.url==='/limited-429'){res.writeHead(429,{'Content-Type':'text/html'}).end('<h1>Too Many Requests</h1>');return;}
 let html=form(req.url==='/unknown');if(req.url==='/error')html=html.replace('action="/submit"','action="/error-submit"');
 if(req.url==='/tamper')html=html.replace('type="submit">','type="submit" onclick="document.getElementById(\'first\').value=\'INVENTED\'">');
 if(req.url==='/hidden')html=html.replace('</form>','<input type="hidden" name="consent" value="yes"></form>');
 if(req.url==='/radio')html=html.replace('</form>','<fieldset><legend>Are you authorized to work in the US?</legend><label><input name="work_authorization" type="radio" value="y" required>Yes</label><label><input name="work_authorization" type="radio" value="n" required>No</label></fieldset></form>');
 if(req.url==='/no-resume')html=html.replace(/<input type="file"[^>]*>/,'');
 res.writeHead(200,{'Content-Type':'text/html'}).end(html);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
function packet(dir){const facts={user_id:'TEST-OWNER',answers:Object.fromEntries(Object.entries({first_name:'Mary Jane',last_name:'Doe',email:'synthetic@example.test'}).map(([key,value],i)=>[key,{value,factId:'TEST-FACT-'+i,confirmed:true,provenance:'owner stated (TEST)',confirmation_event_id:'evt-TEST-FACT-'+i}]))};const factsPath=path.join(dir,'facts.json'),resume=path.join(dir,'synthetic.pdf');fs.writeFileSync(factsPath,JSON.stringify(facts));fs.writeFileSync(resume,'%PDF-1.4\nSYNTHETIC TEST RESUME\n');return {factsPath,resume};}
async function run({route='/form',answer,dir=fs.mkdtempSync(path.join(root,'case-')),onPrompt,alter}={}){
 const {factsPath,resume}=fs.existsSync(path.join(dir,'facts.json'))?{factsPath:path.join(dir,'facts.json'),resume:path.join(dir,'synthetic.pdf')}:packet(dir);
 if(alter){const facts=JSON.parse(fs.readFileSync(factsPath));alter(facts);fs.writeFileSync(factsPath,JSON.stringify(facts));}
 const args=['run','-A',path.join(__dirname,'../scripts/apply.ts'),'--url',base+route,'--facts',factsPath,'--resume',resume,'--state-dir',path.join(dir,'state'),'--evidence-dir',path.join(dir,'evidence')];if(answer!==undefined)args.push('--submit');
 const p=spawn(process.env.DENO_BIN||'deno',args,{env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='',sent=false;
 p.stdout.on('data',b=>{out+=b;if(!sent&&out.includes('Submit this application to ')){sent=true;if(onPrompt)onPrompt({factsPath,resume});p.stdin.end(answer+'\n');}});p.stderr.on('data',b=>err+=b);
 const timer=setTimeout(()=>p.kill('SIGTERM'),60000);const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve);});clearTimeout(timer);
 const line=out.split('\n').filter(l=>l.startsWith('RESULT ')).at(-1);return {code,out,err,result:line?JSON.parse(line.slice(7)):null,dir};
}
// The answers are shown only to a person reviewing at their own terminal (G6): piped (a worker, CI) the review names
// every field and the fact behind it, never the answer itself.
test('009b-4 default dry-run names every field and fact (never an answer when piped), keeps the exact resume hash, reads raw names, and never submits',async()=>{
 const n=receipts.length,r=await run();assert.equal(r.code,0,r.err);assert.equal(r.result.state,'not_submitted');assert.equal(r.result.reason,'dry_run');assert.equal(receipts.length,n);
 for(const i of [0,1,2])assert.match(r.out,new RegExp('"factId":"TEST-FACT-'+i+'"'));for(const name of ['first_name','last_name','email'])assert.match(r.out,new RegExp('"name":"'+name+'"'));
 for(const value of ['Mary Jane','synthetic@example.test'])assert.ok(!r.out.includes(value),'piped output printed '+value);const e=JSON.parse(fs.readFileSync(path.join(r.dir,'evidence','evidence.json')));assert.equal(e.readback.first_name,'Mary Jane');assert.equal(e.readback.last_name,'Doe');assert.equal(e.readback.resume.sha256,e.payload.resume.sha256);
 assert.ok(fs.existsSync(path.join(r.dir,'evidence','before-review.png')));
});
test('009b-4 at the person\'s own terminal the dry-run review shows each answer with its fact',async t=>{
 // script(1) runs the engine with a terminal as its stdin, as the person's own run has.
 const script=['/usr/bin/script','/bin/script'].find(p=>fs.existsSync(p));
 if(!script){if(process.env.CI)assert.fail('script(1) is needed for the terminal case in CI');t.skip('no script(1) here');return;}
 const dir=fs.mkdtempSync(path.join(root,'tty-')),{factsPath,resume}=packet(dir),q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
 const cmd=[process.env.DENO_BIN||'deno','run','-A',path.join(__dirname,'../scripts/apply.ts'),'--url',base+'/form','--facts',factsPath,'--resume',resume,'--state-dir',path.join(dir,'state'),'--evidence-dir',path.join(dir,'evidence')].map(q).join(' ');
 const n=receipts.length,p=spawn(script,['-qefc',cmd,'/dev/null'],{env:{...process.env,NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);
 const timer=setTimeout(()=>p.kill('SIGTERM'),60000);const code=await new Promise(r=>p.once('exit',r));clearTimeout(timer);
 assert.equal(code,0,out);assert.match(out,/"reason":"dry_run"/);assert.equal(receipts.length,n,'never submitted');
 assert.match(out,/"name":"first_name"[^\n]*"value":"Mary Jane"[^\n]*"factId":"TEST-FACT-0"/);assert.match(out,/"value":"synthetic@example.test"[^\n]*"factId":"TEST-FACT-2"/);
});
test('009b-4 --submit accepts only exact yes; no and uppercase YES never click',async()=>{
 const n=receipts.length;for(const answer of ['no','YES']){const r=await run({answer});assert.equal(r.code,0,r.err);assert.equal(r.result.reason,'user_declined');}assert.equal(receipts.length,n);
});
test('009b-4 exact yes submits once, reports employer confirmation, and a repeat cannot redispatch',async()=>{
 const n=receipts.length,dir=fs.mkdtempSync(path.join(root,'confirmed-')),r=await run({answer:'yes',dir});assert.equal(r.code,0,r.err);assert.equal(r.result.state,'confirmed');assert.equal(r.result.confirmation_id,'TEST-12345');assert.equal(receipts.length,n+1);assert.equal(receipts.at(-1).first,'Mary Jane');assert.equal(receipts.at(-1).last,'Doe');
 const again=await run({answer:'yes',dir});assert.equal(again.result.state,'confirmed');assert.equal(again.result.confirmation_id,'TEST-12345');assert.equal(again.result.already_recorded,true);assert.equal(receipts.length,n+1);
});
test('009b-4 an unknown required field stops before review and before submission',async()=>{
 const n=receipts.length,r=await run({route:'/unknown'});assert.equal(r.code,0,r.err);assert.equal(r.result.state,'not_submitted');assert.match(r.out,/Favorite programming language/);assert.equal(receipts.length,n);assert.ok(!fs.existsSync(path.join(r.dir,'evidence','before-review.png')));
});
test('009b-4 an off-domain redirect stops without following or submitting',async()=>{
 const n=receipts.length,r=await run({route:'/redirect'});assert.equal(r.result.state,'not_submitted');assert.equal(r.result.reason,'HOST_REDIRECT_REFUSED');assert.equal(receipts.length,n);
});
test('009b-4 changed confirmed facts after the printed approval cannot be submitted',async()=>{
 const n=receipts.length,r=await run({answer:'yes',onPrompt:({factsPath})=>fs.appendFileSync(factsPath,' ')});assert.equal(r.result.state,'not_submitted');assert.equal(r.result.reason,'FACTS_CHANGED');assert.equal(receipts.length,n);
});
test('009b-4 hidden consent is not guessed or transmitted',async()=>{const n=receipts.length,r=await run({route:'/hidden',answer:'yes'});assert.match(r.result.reason,/UNCONFIRMED_HIDDEN_FIELD/);assert.equal(receipts.length,n);});
// Architect, 2026-10-19 (engine review M4): the refused body never left the browser, so the result is "not sent"
// (reason APPROVED_BODY_MISMATCH), not "unknown" forever. Nothing reaching the employer is still asserted.
test('009b-4 a submit handler cannot change a confirmed answer in the outgoing body',async()=>{const n=receipts.length,r=await run({route:'/tamper',answer:'yes'});assert.equal(r.result.state,'not_submitted');assert.equal(r.result.reason,'APPROVED_BODY_MISMATCH');assert.equal(receipts.length,n);const e=JSON.parse(fs.readFileSync(path.join(r.dir,'evidence','evidence.json')));assert.equal(e.transport_rejection,'APPROVED_BODY_MISMATCH');});
test('009b-4 a lost/rejected server acknowledgement stays unknown and never redispatches',async()=>{const n=receipts.length,dir=fs.mkdtempSync(path.join(root,'unknown-'));const r=await run({route:'/error',answer:'yes',dir});assert.equal(r.result.state,'unknown_outcome');assert.equal(receipts.length,n+1);const again=await run({route:'/error',answer:'yes',dir});assert.equal(again.result.state,'unknown_outcome');assert.equal(again.result.reason,'READBACK_REQUIRED');assert.equal(receipts.length,n+1);});
test('009b-4 explicit pause, erase and foreign fact ownership deny before any effect',async()=>{const n=receipts.length;for(const [reason,alter]of [['ACCOUNT_PAUSED',f=>f.paused=true],['FACTS_ERASED',f=>f.erased=true],['FACT_OWNER_MISMATCH',f=>f.answers.email.user_id='OTHER-OWNER']]){const r=await run({answer:'yes',alter});assert.equal(r.result.reason,reason);}assert.equal(receipts.length,n);});
test('009b-4 same-name radios without ids preserve the confirmed No option',async()=>{const n=receipts.length,r=await run({route:'/radio',answer:'yes',alter:f=>f.answers.work_authorization={value:'No',factId:'TEST-WORK',confirmed:true,provenance:'owner stated (TEST)',confirmation_event_id:'evt-TEST-WORK'}});assert.equal(r.result.state,'confirmed',r.out+r.err);assert.equal(receipts.length,n+1);assert.equal(receipts.at(-1).work,'n');});
test('009b-4 a concurrent duplicate reads unknown, then reconciles the original settlement without another POST',async()=>{
 const n=receipts.length,dir=fs.mkdtempSync(path.join(root,'concurrent-'));let timer;const held=new Promise((resolve,reject)=>{onHeld=resolve;timer=setTimeout(()=>reject(Error('fixture POST not observed')),20000);});
 const original=run({answer:'yes',dir});try{await held;clearTimeout(timer);const asOf=await run({answer:'yes',dir});assert.equal(asOf.result.state,'unknown_outcome');assert.equal(asOf.result.already_recorded,true);assert.equal(receipts.length,n+1);
  heldResponse.writeHead(200,{'Content-Type':'text/html'}).end('<h1>Thank you for applying</h1><p>Application received. Confirmation number: TEST-12345.</p>');heldResponse=null;
  assert.equal((await original).result.state,'confirmed');const settled=await run({answer:'yes',dir});assert.equal(settled.result.state,'confirmed');assert.equal(settled.result.already_recorded,true);assert.equal(receipts.length,n+1);
 }finally{clearTimeout(timer);onHeld=null;if(heldResponse){heldResponse.writeHead(503).end();heldResponse=null;}await original;}
});
test('009b-4 missing observation proof cannot be reconstructed from a cached confirmation',async()=>{
 const n=receipts.length,dir=fs.mkdtempSync(path.join(root,'proof-')),r=await run({answer:'yes',dir});assert.equal(r.result.state,'confirmed');
 const file=path.join(dir,'evidence','evidence.json'),e=JSON.parse(fs.readFileSync(file));delete e.observation.form_present_after;fs.writeFileSync(file,JSON.stringify(e));
 const again=await run({answer:'yes',dir});assert.equal(again.result.state,'unknown_outcome');assert.equal(again.result.reason,'READBACK_REQUIRED');assert.equal(receipts.length,n+1);
});
test('009b-4 a final review without an observed resume input cannot be approved',async()=>{const n=receipts.length,r=await run({route:'/no-resume',answer:'yes'});assert.equal(r.result.state,'not_submitted');assert.equal(r.result.reason,'RESUME_INPUT_NOT_OBSERVED');assert.equal(receipts.length,n);});

// Owner rule (2026-10-27): back off only when an outside system refuses, then RESUME. A 503 at the page's open is the site
// refusing for load whether or not it says when to come back (before, only a 503 with Retry-After was; one without it
// ran on as an ordinary page and the application ended unsent instead of being put back): HOST_RATE_LIMITED, nothing
// filled or sent, the seconds asked for or none (the workers' default doubling).
test('a 503 at the page with no Retry-After is a refusal for load (HOST_RATE_LIMITED, no seconds), like a 503 with one and a 429; nothing is filled or sent',async()=>{
 for(const [route,status,secs] of [['/busy-503',503,null],['/busy-503-ra',503,7],['/limited-429',429,null]]){
  const n=receipts.length,r=await run({route,answer:'yes'});
  assert.ok(r.result,route+': no RESULT line: '+r.err.slice(0,400));
  assert.deepEqual({state:r.result.state,reason:r.result.reason,status:r.result.status,retry_after_s:r.result.retry_after_s},{state:'not_submitted',reason:'HOST_RATE_LIMITED',status,retry_after_s:secs},route);
  assert.equal(receipts.length,n,route+': nothing was sent');
  assert.ok(!r.out.includes('Submit this application to '),route+': never asked to submit');
 }
});
