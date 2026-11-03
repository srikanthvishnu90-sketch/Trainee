import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenPicks, wantsFrom } from '../../supabase/functions/_shared/career_apply_want.ts';
const now = Date.parse('2026-10-28T04:00:00Z');
const pick = { company: 'Acme', title: 'Data Analyst', url: 'https://jobs.lever.co/acme/12345678-1234-1234-1234-123456789012' };
test('a recent application to another role at the same company does not block the new posting', () => {
 const r=screenPicks([pick],{apps:[{company:'Acme',role:'Other role',stage:'Applied',applied_at:new Date(now-1000).toISOString(),source:'tracker'}],facts:[],now});
 assert.equal(r.ok.length,1);assert.equal(r.refused.length,0);
});
test('current-employer guard remains intact',()=>{
 const r=screenPicks([pick],{apps:[],facts:[{key:'employer',text:'I work at Acme',value:'Acme'}],now,resolved:[{company:'Acme',is_employer:true}]});
 assert.equal(r.ok.length,0);assert.equal(r.refused.length,1);
});
test('same exact posting in a requested batch remains deduplicated',()=>{
 const r=wantsFrom([pick,pick],now);assert.equal(r.ok.length,1);
});

test('recorded exact posting remains blocked regardless of its date',()=>{
 const r=screenPicks([pick],{apps:[{ref:'old',company:'Acme',stage:'Submitted',source:'tracker',url:pick.url,applied_at:'2020-01-01'}],facts:[],now});
 assert.equal(r.ok.length,0);assert.match(r.refused[0].reason,/same posting/);
});
test('a saved posting is not an existing application',()=>{
 const r=screenPicks([pick],{apps:[{ref:'saved',company:'Acme',stage:'Saved',source:'tracker',url:pick.url}],facts:[],now});assert.equal(r.ok.length,1);
});
