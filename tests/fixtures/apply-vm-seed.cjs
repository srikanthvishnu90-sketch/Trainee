"use strict";
// Shared by tests/career-apply-vm.test.cjs and scripts/career/apply-vm-loadtest.cjs: a throwaway Postgres with every
// migration (tests/flow/provision-pg.sh), and bulk seeding of people, a kept resume and approved queue rows. Test data only.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "../..");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

function provision(port) {
  if (process.env.APPLY_VM_PG) { const [dir, p] = process.env.APPLY_VM_PG.split(":"); return { dir, port: Number(p), stop() {} }; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "apply-vm-pg-"));
  // INCLUDE_BRIDGE=1: the card-cloud bridge holds the stored approvals (cloud_bound_refusal) the claim checks; without it nothing is approved.
  const out = execFileSync("bash", [path.join(ROOT, "tests/flow/provision-pg.sh"), work, String(port)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, INCLUDE_BRIDGE: "1" } });
  const m = /PGHOST=(\S+) PGPORT=(\d+)/.exec(out);
  return { dir: m[1], port: Number(m[2]), stop() { try { execFileSync("runuser", ["-u", "postgres", "--", "pg_ctl", "-D", path.join(work, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* gone */ } } };
}
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RESUME = Buffer.from("%PDF-1.4\n% TEST resume for the apply VM\n");
const RESUME_SHA = sha256(RESUME);

// n people (ids uid(base+1..base+n)) who said yes to cloud sending, each with the kept resume and a current account.
async function seedPeople(admin, base, n) {
  await admin.q(`insert into auth.users(id,email) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid, 'vm'||(${base}+g)||'@example.test' from generate_series(1,${n}) g on conflict do nothing`);
  await admin.q(`insert into profiles(id) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid from generate_series(1,${n}) g on conflict do nothing`);
  await admin.q(`insert into career_watch_kv(user_id,key,value) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb from generate_series(1,${n}) g on conflict do nothing`);
  await admin.q(`insert into career_apply_cloud_optin(user_id,enabled,terms,terms_sha256,privacy_epoch,turned_on_at) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid,true,'test terms',repeat('a',64),1,now() from generate_series(1,${n}) g on conflict do nothing`);
  await admin.q(`insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid,'${RESUME_SHA}','resume.pdf',decode('${RESUME.toString("hex")}','hex'),1 from generate_series(1,${n}) g on conflict do nothing`);
  await admin.q(`insert into career_message_approval_private.test_users(user_id) select ('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid from generate_series(1,${n}) g on conflict do nothing`);
  // the one confirmed resume on file (owner rule 2026-10-26: no resume, no queue row)
  await admin.q(`select public.career_resume_put(('00000000-0000-4000-8000-'||lpad((${base}+g)::text,12,'0'))::uuid,'${RESUME_SHA}','file','test:apply-vm','resume.pdf',decode('${RESUME.toString("hex")}','hex'),'seed:'||g) from generate_series(1,${n}) g`);
}
// Queue rows WITH real stored approvals, the way a tapped card leaves them: a used career_apply_batch_approvals row and its
// career_message_approval_private.cloud_bound_approvals row for exactly this payload, created before the queue insert (the queue
// trigger binds the row to it). `rowsSql` is a deterministic SQL select of (u uuid text, jid, co, url, p jsonb) - it is run twice.
// mode: 'ok' (default) | 'none' (enqueued directly: no approval at all) | 'wrong_hash' (the approval is for a different payload)
//       | 'revoked' | 'expired' (a valid approval that was then revoked / ran out) | 'other_user' (the approval belongs to someone else).
async function seedRows(admin, rowsSql, mode = "ok", otherUser = null) {
  const ap = (hashOf, userOf) => `with s as (${rowsSql}), a as (insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at)
     select ${userOf}, s.jid, ${hashOf}, case when ${hashOf} = public.career_apply_payload_hash(s.p) then s.p else s.p || '{"changed":true}'::jsonb end, now(), now() from s returning id, user_id, job_id, batch_hash)
    insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
     select a.id, a.user_id, gen_random_uuid(), 0, a.batch_hash, now(), now() + interval '23 hours' from a`;
  if (mode === "ok" || mode === "revoked" || mode === "expired") await admin.q(ap("public.career_apply_payload_hash(s.p)", "s.u::uuid"));
  if (mode === "wrong_hash") await admin.q(ap("public.career_apply_payload_hash(s.p || '{\"changed\":true}'::jsonb)", "s.u::uuid"));
  if (mode === "other_user") await admin.q(ap("public.career_apply_payload_hash(s.p)", `'${otherUser}'::uuid`));
  await admin.q(`with s as (${rowsSql}) insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
   select s.u::uuid, s.jid, s.co, s.url, s.p, public.career_apply_payload_hash(s.p), public.career_apply_payload_hash(s.p) from s`);
  if (mode === "revoked") await admin.q(`with s as (${rowsSql}) update career_message_approval_private.cloud_bound_approvals a set revoked_at = now() from s where a.user_id = s.u::uuid and a.payload_hash = public.career_apply_payload_hash(s.p)`);
  if (mode === "expired") await admin.q(`with s as (${rowsSql}) update career_message_approval_private.cloud_bound_approvals a set approved_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' from s where a.user_id = s.u::uuid and a.payload_hash = public.career_apply_payload_hash(s.p)`);
}
const PAYLOAD = (extra) => `jsonb_build_object('version',1,'user_id',x.u,'job_id',x.jid,'company',x.co,'url',x.url,'fields',${extra.fields},'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${RESUME_SHA}','destination',x.url)`;
const FIELDS = `'[{"label":"First Name","value":"Test","factId":"f1"},{"label":"Last Name","value":"Person","factId":"f2"},{"label":"Full name","value":"Test Person","factId":"f2"},{"label":"Email","value":"test.person@example.invalid","factId":"f3"},{"label":"Are you legally authorized to work in the United States?","value":"Yes","factId":"f4"},{"label":"Will you now or in the future require sponsorship for employment visa status?","value":"No","factId":"f5"}]'::jsonb`;
// items per person for people base+1..base+n; urlSql is a SQL expression over u (uuid text), g (item number) giving the link; fieldsSql the fields array.
async function seedItems(admin, base, n, items, urlSql, fieldsSql = FIELDS, mode = "ok", ids = { job: "JOB-", co: "Co " }, otherUser = null) {
  const rowsSql = `select x.u, x.jid, x.co, x.url, ${PAYLOAD({ fields: fieldsSql })} as p
    from (select u, '${ids.job}'||g as jid, '${ids.co}'||g as co, ${urlSql} as url from (select '00000000-0000-4000-8000-'||lpad((${base}+i)::text,12,'0') as u, i, g from generate_series(1,${n}) i, generate_series(1,${items}) g) z) x`;
  await seedRows(admin, rowsSql, mode, otherUser);
}
module.exports = { provision, seedPeople, seedItems, seedRows, PAYLOAD, FIELDS, uid, RESUME, RESUME_SHA, sha256, ROOT };
