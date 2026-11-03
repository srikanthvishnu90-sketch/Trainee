// The Deno chat handler imports the career domain modules from a generated bundle; a stale bundle would run old
// code in production while the node tests pass on the new code. Check: node --test tests/router-bundle.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('supabase/functions/_shared/router_core.career.js is current with packages/domain',()=>{
  const r=spawnSync('python3',[path.join(root,'scripts/build-router-core.py'),'--career-only','--check'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);
});
test('the bundle loads as an ES module and exports the career seam modules',async()=>{
  // Replay for the Gate 0 bundle defects: 130/141/143 travelled outside the bundle, and 134-career-paths had an
  // unguarded top-level require that broke ESM execution.
  const {pathToFileURL}=require('node:url');
  const m=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/router_core.career.js')).href);
  for(const k of ['CareerOnboarding','CareerDoorstep','CareerContainment','CareerRouter']) assert.equal(typeof m[k],'object',k);
});
