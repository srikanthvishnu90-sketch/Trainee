// scripts/launch/go-live.sh in dry-run mode: the plan, in order, with nothing touched and no secret printed.
// Check: node --test tests/go-live.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const run=env=>execFileSync('bash',[path.join(root,'scripts/launch/go-live.sh')],{cwd:root,encoding:'utf8',env:Object.assign({PATH:process.env.PATH,HOME:process.env.HOME||'/tmp'},{GO_LIVE_DRY_RUN:'1'},env||{})});

test('dry run: preflight, only pending migrations (ledger), deploys incl. model-health, a live model call that stops the run when it fails, deploys with the callback public, smoke, gauntlet, rollback, in that order',()=>{
  const out=run();
  const order=['== 0. preflight','== 1. migrations','DRY: bash scripts/launch/apply-rails-and-seed.sh --pending','== 2. secrets','== 3. deploy','DRY: supabase functions deploy agent-chat --project-ref mrwngntwmnaqrqhupvlt','DRY: supabase functions deploy broker-oauth-start --project-ref mrwngntwmnaqrqhupvlt','DRY: supabase functions deploy broker-oauth-callback --project-ref mrwngntwmnaqrqhupvlt --no-verify-jwt','DRY: supabase functions deploy model-health --project-ref mrwngntwmnaqrqhupvlt --no-verify-jwt','== 4. smoke','GET model-health?probe=1','or STOP with the provider\'s error','== 5. live gauntlet','== 6. rollback'];
  let at=-1;for(const step of order){const i=out.indexOf(step);assert.ok(i>at,`${step} comes next`);at=i;}
  assert.match(out,/skipped: no Alpaca OAuth pair given; Connect will say it isn't switched on yet/);
  assert.doesNotMatch(out,/supabase db push/,'never a replay of all 59 migrations');
  // The agent speaks first: the scheduler is deployed public (its own secret), scheduled hourly from Vault, and smoke-tested.
  const p=['DRY: supabase functions deploy agent-proactive --project-ref mrwngntwmnaqrqhupvlt --no-verify-jwt','DRY: psql <SUPABASE_DB_URL> -v url=https://mrwngntwmnaqrqhupvlt.supabase.co/functions/v1/agent-proactive -f scripts/launch/schedule-proactive.sql','POST agent-proactive with no secret -> 401'];
  let j=out.indexOf('== 3. deploy');for(const step of p){const i=out.indexOf(step);assert.ok(i>j,`${step} comes next`);j=i;}
  const sql=require('node:fs').readFileSync(path.join(root,'scripts/launch/schedule-proactive.sql'),'utf8');
  assert.match(sql,/decrypted_secrets where name = 'upmore_proactive_secret'/,'the job reads the secret from Vault at call time');
  assert.match(sql,/cron\.unschedule\('upmore-proactive'\)/,'a re-run replaces the job instead of adding a second one');
});

test('dry run with the OpenAI key, the health token and the Alpaca pair: names only, the values are never printed',()=>{
  const out=run({ALPACA_OAUTH_CLIENT_ID:'cid-should-not-print',ALPACA_OAUTH_CLIENT_SECRET:'secret-should-not-print',ANTHROPIC_API_KEY:'sk-proj-should-not-print',HEALTH_CHECK_TOKEN:'token-should-not-print-0123456789',PROACTIVE_SECRET:'proactive-should-not-print-0123456789',SUPABASE_DB_URL:'postgresql://u:dbpass-should-not-print@h/db'});
  assert.match(out,/supabase secrets set --project-ref mrwngntwmnaqrqhupvlt --env-file <0600 temp file: ANTHROPIC_API_KEY ALPACA_OAUTH_CLIENT_ID ALPACA_OAUTH_CLIENT_SECRET HEALTH_CHECK_TOKEN PROACTIVE_SECRET>/);
  assert.doesNotMatch(out,/should-not-print/);
});

test('dry run without an OpenAI key: an already-set secret is left alone, and a fresh run never replays applied migrations',()=>{
  const out=run({HOME:require('node:os').tmpdir()+'/upmore-go-live-test-home'});
  assert.match(out,/skipped: no ANTHROPIC_API_KEY given \(an already-set secret stays as it is\)/);
  assert.match(out,/apply-rails-and-seed\.sh --pending/);assert.doesNotMatch(out,/--all/);
});

test('dry run: the no-password functions are deployed, and the security checks run before the gauntlet and stop it on a FAIL',()=>{
  const out=run();
  const order=['== 3. deploy','DRY: supabase functions deploy exec-vault-store --project-ref mrwngntwmnaqrqhupvlt','DRY: supabase functions deploy agent-exec --project-ref mrwngntwmnaqrqhupvlt','== 5. live gauntlet','run scripts/launch/verify-security-live.cjs','STOP on a FAIL','then run spec16, sloppy, l3'];
  let at=-1;for(const step of order){const i=out.indexOf(step);assert.ok(i>at,`${step} comes next`);at=i;}
  const src=require('node:fs').readFileSync(path.join(root,'scripts/launch/go-live.sh'),'utf8');
  assert.ok(src.indexOf('node scripts/launch/verify-security-live.cjs ||')<src.indexOf('for s in spec16 sloppy l3'),'the checks gate the gauntlet');
  assert.ok(!/--no-verify-jwt/.test(src.split('\n').filter(l=>/deploy (exec-vault-store|agent-exec)/.test(l)).join('\n')),'both keep JWT verification, as they run live today');
});

test('dry run: guided manual connect (the live sign-in window) is deployed after the no-password functions with JWT on, and smoke-tested for a 401',()=>{
  const out=run();
  const order=['== 3. deploy','DRY: supabase functions deploy agent-exec --project-ref mrwngntwmnaqrqhupvlt','DRY: supabase functions deploy manual-connect --project-ref mrwngntwmnaqrqhupvlt\n','DRY: psql <SUPABASE_DB_URL>','== 4. smoke','POST manual-connect with no JWT -> 401','== 5. live gauntlet'];
  let at=-1;for(const step of order){const i=out.indexOf(step);assert.ok(i>at,`${JSON.stringify(step)} comes next`);at=i;}
  const src=require('node:fs').readFileSync(path.join(root,'scripts/launch/go-live.sh'),'utf8');
  const line=src.split('\n').find(l=>/deploy manual-connect/.test(l));
  assert.ok(line&&!/--no-verify-jwt/.test(line),'JWT verification stays on: every action is the signed-in person\'s own');
  assert.match(src,/expect 401 "\$\(curl -s -o \/dev\/null -w '%\{http_code\}' -X POST "\$BASE\/functions\/v1\/manual-connect"\)" "manual-connect refuses a call with no JWT"/);
  assert.match(require('node:fs').readFileSync(path.join(root,'supabase/config.toml'),'utf8'),/\[functions\.manual-connect\]\nverify_jwt = true/);
});

test('the owner one-command runner: hidden prompts only, secrets forgotten after, results pushed, never a secret echoed',()=>{
  const s=require('node:fs').readFileSync(path.join(root,'scripts/launch/owner-go-live.sh'),'utf8');
  for(const v of ['SUPABASE_DB_URL','GAUNTLET_PASSWORD','ANTHROPIC_API_KEY','ALPACA_OAUTH_CLIENT_ID','ALPACA_OAUTH_CLIENT_SECRET']){
    assert.ok(new RegExp(`ask ${v} "`).test(s),`${v} is asked on a hidden prompt`);
    assert.ok(!new RegExp(`echo[^\\n]*\\$\\{?${v}`).test(s),`${v} is never echoed`);
  }
  assert.match(s,/read -rs/);
  assert.ok(s.indexOf('unset SUPABASE_DB_URL GAUNTLET_PASSWORD ANTHROPIC_API_KEY')>s.indexOf('bash scripts/launch/go-live.sh'),'forgotten right after the run');
  assert.match(s,/git add evals\/gauntlet\/results evals\/gauntlet\/replays/);
  assert.match(s,/\[\[ -z "\$\(git status --porcelain\)" \]\]/,'never runs on uncommitted changes');
});
