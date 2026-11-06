// G2 (review of PR #547/#549): 20261106120000 backfilled the missing 'career:account' rows but not the cloud copies of resumes already
// confirmed while the row was absent (career_resume_put skipped the copy; a same-hash re-upload returned early before writing it).
//   pg: confirmed file resume, no account row, no cloud copy (the pre-#547 state) -> after the migrations the copy exists at the account's
//   epoch, cloud preparation's kept_for returns it, generation and account version/authority_version are unchanged; a paused account, an
//   erased account (epoch > 0), and a person who turned the cloud off are NOT revived; a same-hash re-upload repairs a missing copy too.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const M1 = "20261106120000_career_apply_candidates_missing_account_row.sql";
const M2 = "20261106130000_career_resume_cloud_copy_recovery.sql";

Deno.test("resume cloud copy recovery: migration, rollback and go-live list agree", () => {
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${M2}`);
  assert(sql.includes("grant execute on function public.career_resume_put(uuid, text, text, text, text, bytea, text) to service_role;"));
  assert(/revoke all on function public\.career_resume_put\(uuid, text, text, text, text, bytea, text\) from public, anon, authenticated;/.test(sql));
  assert(Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/${M2.replace(".sql", ".down.sql")}`).includes("create or replace function public.career_resume_put("));
  const golive = Deno.readTextFileSync(`${ROOT}/scripts/launch/trainee-go-live.sh`);
  assert(golive.includes(`  ${M2}\n`));
});

Deno.test({
  name: "pg: confirmed resumes without a cloud copy are restored; paused, erased and opted-out people are not; re-upload repairs",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg({ includeBridge: true });
    try {
      const id = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-${String(n).padStart(12, "0")}`;
      const [live, paused, erased, off, paste] = [id(911), id(912), id(913), id(914), id(915)];
      const hex = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
      await pg.sql(`insert into auth.users (id, email) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'g' || g || '@example.test' from generate_series(911, 915) g;
        insert into public.profiles (id) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid from generate_series(911, 915) g;`);
      // The pre-#547 state, as rows: the old career_resume_put confirmed the file (record + bytes) and kept no cloud copy (no account row).
      await pg.sql(`insert into public.career_resume_record (user_id, state, sha256, kind, source_ref, filename, bytes, confirmation_event_id, confirmed_at, generation)
        select u, 'confirmed', '${hex}', 'file', 'ref', 'r.pdf', convert_to('hello', 'UTF8'), 'evt-' || u, now(), 1 from unnest(array['${live}', '${paused}', '${erased}', '${off}']::uuid[]) u;
        insert into public.career_resume_record (user_id, state, sha256, kind, source_ref, confirmation_event_id, confirmed_at, generation)
        values ('${paste}', 'confirmed', '${hex}', 'paste', 'ref', 'evt-p', now(), 1);
        delete from public.career_apply_cloud_resumes where user_id::text like '7b0f8f8e-6a43-4a49-9d2c-0000000009%';
        delete from public.career_watch_kv where user_id::text like '7b0f8f8e-6a43-4a49-9d2c-0000000009%' and key = 'career:account';`);
      eq((await pg.sql(`select count(*) from public.career_apply_cloud_resumes where user_id::text like '7b0f8f8e-6a43-4a49-9d2c-0000000009%'`)).trim(), "0", "setup: no cloud copies");
      eq((await pg.sql(`select count(*) from public.career_watch_kv where key = 'career:account' and user_id = '${live}'`)).trim(), "0", "setup: no account row");
      // The account states that must not be revived (rows as erase / pause / cloud opt-out leave them).
      await pg.sql(`insert into public.career_watch_kv (user_id, key, value) values
         ('${paused}', 'career:account', '{"version":3,"epoch":0,"paused":true}'),
         ('${erased}', 'career:account', '{"version":3,"epoch":1,"paused":false}'),
         ('${off}', 'career:account', '{"version":3,"epoch":0}');
        insert into public.career_apply_cloud_optin (user_id, enabled, terms, terms_sha256, daily, privacy_epoch, turned_off_at)
         values ('${off}', false, 't', encode(sha256(convert_to('t', 'UTF8')), 'hex'), 5, 0, now());`);
      const snap = async (u: string) => (await pg.sql(`select r.generation || '|' || r.sha256 || '|' || r.updated_at::text from public.career_resume_record r where r.user_id = '${u}'`)).trim();
      const before = await snap(live);
      for (const f of [M1, M1, M2, M2]) await pg.sql(Deno.readTextFileSync(`${ROOT}/supabase/migrations/${f}`));
      const copies = async (u: string) => (await pg.sql(`select count(*) || '|' || coalesce(max(privacy_epoch), -1) from public.career_apply_cloud_resumes where user_id = '${u}'`)).trim();
      // (a) the copy exists at the account's epoch (0), (b) record untouched, account row is the backfilled default, (c) kept_for returns it.
      eq(await copies(live), "1|0", "restored for the confirmed person");
      eq(await snap(live), before, "generation, hash and updated_at of the resume record unchanged");
      eq((await pg.sql(`select value::text from public.career_watch_kv where user_id = '${live}' and key = 'career:account'`)).trim(), '{"epoch": 0, "version": 0, "authority_version": 0}');
      eq((await pg.sql(`select public.career_apply_cloud_resume_kept_for('${live}')->>'sha256'`)).trim(), hex);
      // (d) not revived.
      eq(await copies(paused), "0|-1", "paused account");
      eq(await copies(erased), "0|-1", "erased account (epoch > 0)");
      eq(await copies(off), "0|-1", "turned the cloud off");
      eq(await copies(paste), "0|-1", "a paste has no file");
      // Same-hash re-upload repairs a missing copy without touching the record or the account row.
      await pg.sql(`delete from public.career_apply_cloud_resumes where user_id = '${live}'`);
      const r = JSON.parse(await pg.sql(`select public.career_resume_put('${live}', '${hex}', 'file', 'ref', 'r.pdf', convert_to('hello', 'UTF8'), 'evt-again')`));
      eq([r.changed, r.generation], [false, 1]);
      eq(await copies(live), "1|0", "re-upload put the copy back");
      eq(await snap(live), before);
      eq((await pg.sql(`select value::text from public.career_watch_kv where user_id = '${live}' and key = 'career:account'`)).trim(), '{"epoch": 0, "version": 0, "authority_version": 0}');
      // A paused account's same-hash re-upload does not write a copy.
      await pg.sql(`select public.career_resume_put('${paused}', '${hex}', 'file', 'ref', 'r.pdf', convert_to('hello', 'UTF8'), 'evt-again')`);
      eq(await copies(paused), "0|-1");
      // Idempotent: the recovery never duplicates or overwrites an existing copy.
      await pg.sql(Deno.readTextFileSync(`${ROOT}/supabase/migrations/${M2}`));
      eq(await copies(live), "1|0");
    } finally { await pg.stop(); }
  },
});
