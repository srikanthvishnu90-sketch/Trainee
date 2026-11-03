// G3 and the staged draft card-cloud bridge (20261024130000, unchanged): both replace career_apply_claim_own(integer,
// text), so the order they are applied in decides whether the claim still re-checks the approval. Proved on a throwaway
// Postgres (tests/flow/pg.ts), by what the claim does with an application whose payload changed after it was approved:
//   safe order (filename order, the bridge before the ledger): the claim closes it as not sent;
//   losing order (the bridge after the ledger): the re-check is gone and the claim hands it to a drive.
// Go-live and apply-rails-and-seed.sh apply in filename order (tests/trainee-go-live.test.cjs refuses go-live putting
// the bridge after the ledger); the losing order is any later apply of the bridge on its own, which the sequencing plan
// (branch arch/migration-sequencing) reconciles. Nothing here reaches the live project.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BRIDGE = `${ROOT}/supabase/migrations/20261024130000_career_apply_card_cloud_bridge.sql`;
const DAY = 86400000;

Deno.test({
  name: "G3/order the claim's approval re-check survives the safe order and is gone in the losing one",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the order test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    let n = 0;
    // A person with two approved applications; one is then changed past every trigger (as a restore or a bad write could).
    const scene = async (pg: Pg) => {
      const u = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      await pg.sql(`insert into auth.users (id) values ('${u}');
        insert into public.profiles (id) values ('${u}') on conflict do nothing;
        insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
          // OWNER RULE 2026-10-26 (20261026210016, review of PR #194): a confirmed resume on file and the stored resume the payloads bind.
          await pg.sql(`with t as (insert into public.agent_threads (user_id) values ('${u}') returning id)
            insert into public.agent_flow_state (thread_id, user_id, state) select id, '${u}', '{"career":{"stores":{"profile":{"facts":[{"id":"seed","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-ev","text":"TEST Analyst"}]}}}}' from t;
            insert into public.career_events (user_id, kind, subject, detail) values ('${u}', 'fact_confirmed', 'TEST Analyst', '{"confirmation_event_id":"seed-ev"}');
            insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('d', 64) || '.pdf');`);
      for (const [job, company] of [["ok", "Acme"], ["tampered", "Globex"]]) {
        const p = {
          version: 1, user_id: u, job_id: job, company, url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${job}`,
          fields: [{ name: "first_name", value: "Ada" }], privacy_epoch: 0, account_version: 0,
          expires_at: new Date(Date.now() + DAY).toISOString(),
          resume_sha256: "d".repeat(64), // OWNER RULE 2026-10-26 (20261026210016): an approved application binds its resume
        };
        const h = await pg.sql(`select public.career_apply_payload_hash($j$${JSON.stringify(p)}$j$::jsonb)`);
        const r = await pg.asService().rpc("career_apply_enqueue", { p_payload: p, p_hash: h, p_approval: h, p_daily: 25 });
        assertNode.equal(r.error, null, `enqueue ${job}: ${r.error?.message}`);
      }
      await pg.sql(`set session_replication_role = replica;
        update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"') where user_id = '${u}' and job_id = 'tampered';
        set session_replication_role = origin;`);
      return u;
    };
    const claim = async (pg: Pg, u: string) => {
      const r = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 6, p_source: "own_computer" });
      assertNode.equal(r.error, null, r.error?.message);
      return (r.data as { job_id: string }[]).map((j) => j.job_id).sort();
    };
    const stateOf = async (pg: Pg, u: string, job: string) =>
      await pg.sql(`select state || '|' || coalesce(reason, '') from public.career_apply_jobs where user_id = '${u}' and job_id = '${job}'`);
    const recheck = async (pg: Pg) =>
      (await pg.sql(`select pg_get_functiondef('public.career_apply_claim_own(integer,text)'::regprocedure) ~ 'career_apply_void_unsendable'`)) === "t";

    await t.step("safe order: the bridge, then the ledger (filename order): a changed application is never claimed", async () => {
      const pg = await startPg({ includeBridge: true });
      try {
        assertNode.equal(await pg.sql(`select to_regclass('career_message_approval_private.cloud_bound_jobs') is not null`), "t", "the bridge is installed");
        assertNode.equal(await recheck(pg), true, "the claim re-checks the approval");
        const u = await scene(pg);
        assertNode.deepEqual(await claim(pg, u), ["ok"]);
        assertNode.equal(await stateOf(pg, u, "tampered"), "not_submitted|not sent: the application changed after it was approved");
      } finally {
        await pg.stop();
      }
    });

    await t.step("losing order: the bridge after the ledger: the re-check is GONE and the changed application is claimed", async () => {
      const pg = await startPg();
      try {
        assertNode.equal(await recheck(pg), true, "before the bridge, the claim re-checks the approval");
        await pg.sql(await Deno.readTextFile(BRIDGE));
        assertNode.equal(await recheck(pg), false, "the bridge applied last replaces the claim without the re-check");
        const u = await scene(pg);
        assertNode.deepEqual(await claim(pg, u), ["ok", "tampered"], "the changed application is handed to a drive");
        assertNode.equal(await stateOf(pg, u, "tampered"), "driving|");
      } finally {
        await pg.stop();
      }
    });
  },
});
