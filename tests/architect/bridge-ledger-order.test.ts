// Migration sequencing: the staged draft card-cloud bridge (20261024130000, unchanged, evidence) and the one-ledger file
// (20261025100000) both replace career_apply_claim_own(integer, text) and career_apply_cloud_refusal; whichever is applied
// last wins the two whole. 20261025110000 reconciles them (docs/architect/MIGRATION-SEQUENCING-BRIDGE-LEDGER.md).
// Every order is run on a throwaway Postgres (tests/flow/pg.ts), and each one ends with both files' guarantees, shown by
// what the claim does, not only by the function text:
//   A. no bridge (CI's order today): G3 whole;
//   B. the bridge applied after the ledger (the losing order): G3 is lost from the two until the reconcile; through the
//      owner's launch script (apply-rails-and-seed.sh --pending) the reconcile runs after the bridge and the run stops
//      unless nothing is missing;
//   C. filename order with the bridge: the reconcile file restores the bridge's half;
//   D. the bridge's rollback after the ledger: G3 is lost until the reconcile, which restores 20261025100000's own two.
// Nothing here reaches the live project.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MIG = `${ROOT}/supabase/migrations`;
const BRIDGE = "20261024130000_career_apply_card_cloud_bridge.sql";
const LEDGER = "20261025100000_career_apply_one_ledger.sql";
const RECONCILE = "20261025110000_career_apply_bridge_reconcile.sql";
const ROLLBACK = `${ROOT}/supabase/rollbacks/${BRIDGE}`;
// The staged bridge and its rollback are evidence: this plan is written around them, never into them.
const BRIDGE_SHA256 = "c5ac429e5e6559d91b35475d719f828a8288d9763c1529a1c1adea0ca8e90fc8";
const ROLLBACK_SHA256 = "5716f7256fb78e681023482647a843e33aab25e5d6136152395205dd11f51186";
const DAY = 86400000;

const sha256 = async (path: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)))).map((b) => b.toString(16).padStart(2, "0")).join("");
// One function's whole `create or replace` statement, as the file has it.
function fnText(src: string, name: string): string {
  const at = src.indexOf(`create or replace function public.${name}(`);
  assertNode.ok(at >= 0, name);
  const end = src.indexOf("\nend $$;", at);
  return src.slice(at, end + "\nend $$;".length);
}
// The texts 20261025110000 installs, in order: ledger claim, ledger refusal, merged claim, merged refusal.
function installed(src: string): string[] {
  return [...src.matchAll(/execute \$body\$([\s\S]*?)\$body\$;/g)].map((m) => m[1]);
}
const isSubsequence = (small: string[], big: string[]) => {
  let i = 0;
  for (const l of big) if (i < small.length && l === small[i]) i++;
  return i === small.length;
};

Deno.test("order/text the bridge and its rollback are unchanged; the reconcile's texts are the two files', line for line", async () => {
  assertNode.equal(await sha256(`${MIG}/${BRIDGE}`), BRIDGE_SHA256, "the staged bridge file changed");
  assertNode.equal(await sha256(ROLLBACK), ROLLBACK_SHA256, "the bridge's rollback file changed");
  const ledger = await Deno.readTextFile(`${MIG}/${LEDGER}`), bridge = await Deno.readTextFile(`${MIG}/${BRIDGE}`);
  const [lClaim, lRef, mClaim, mRef] = installed(await Deno.readTextFile(`${MIG}/${RECONCILE}`));
  // Without the bridge: 20261025100000's two, exactly.
  assertNode.equal(lClaim, fnText(ledger, "career_apply_claim_own"));
  assertNode.equal(lRef, fnText(ledger, "career_apply_cloud_refusal"));
  // With it: every line of each file's version, in its order, and no line from anywhere else. Where both change the same
  // check, one wins, by name: the cloud's daily cap is the bridge's (15 a day, 7bbd2096); the company cooldown is the
  // ledger's (the queue, the extension's reports and the old batch stack, where the bridge read the queue alone).
  for (const [name, merged] of [["career_apply_claim_own", mClaim], ["career_apply_cloud_refusal", mRef]] as const) {
    const m = merged.split("\n"), b = fnText(bridge, name).split("\n"), l = fnText(ledger, name).split("\n");
    const lKept = l.filter((x) => !/least\(coalesce\(o\.daily, 25\)/.test(x));
    const bKept = b.filter((x) => !/^ if co <> '' and exists \(select from public\.career_apply_jobs x |^  and coalesce\(x\.claimed_at, x\.created_at\) > p_now - interval '30 days'/.test(x));
    assertNode.equal(b.length - bKept.length, name === "career_apply_cloud_refusal" ? 2 : 0, `${name}: only the bridge's queue-only cooldown gives way`);
    assertNode.ok(isSubsequence(bKept, m), `${name}: a bridge line is missing or moved`);
    assertNode.ok(isSubsequence(lKept, m), `${name}: a G3 line is missing or moved`);
    assertNode.deepEqual(m.filter((x) => !b.includes(x) && !l.includes(x)), [], `${name}: a line from neither file`);
  }
});

Deno.test({
  name: "order/db every order of the bridge and the ledger ends with both files' guarantees",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the order test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    let n = 0;
    const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const missing = async (pg: Pg) => {
      const out = await pg.sql(`select coalesce(array_to_json(public.career_apply_guards_missing())::text, '[]')`);
      return JSON.parse(out) as string[];
    };
    const bridgeInstalled = async (pg: Pg) =>
      (await pg.sql(`select to_regclass('career_message_approval_private.cloud_bound_jobs') is not null`)) === "t";
    // A person, an approved queued application, and the two rows the two halves are about: one whose payload was changed
    // past every trigger after approval (G3 must close it), one the bridge bound to a cloud card (the person's own claim
    // must leave it to the cloud).
    const scene = async (pg: Pg) => {
      const u = uid();
      await pg.sql(`insert into auth.users (id) values ('${u}');
        insert into public.profiles (id) values ('${u}') on conflict do nothing;
        insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
          // OWNER RULE 2026-10-26 (20261026210016, review of PR #194): a confirmed resume on file and the stored resume the payloads bind.
          await pg.sql(`with t as (insert into public.agent_threads (user_id) values ('${u}') returning id)
            insert into public.agent_flow_state (thread_id, user_id, state) select id, '${u}', '{"career":{"stores":{"profile":{"facts":[{"id":"seed","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-ev","text":"TEST Analyst"}]}}}}' from t;
            insert into public.career_events (user_id, kind, subject, detail) values ('${u}', 'fact_confirmed', 'TEST Analyst', '{"confirmation_event_id":"seed-ev"}');
            insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('d', 64) || '.pdf');`);
      const svc = pg.asService();
      for (const [job, company] of [["ok", "Acme"], ["tampered", "Globex"], ["bound", "Initech"]]) {
        const p = {
          version: 1, user_id: u, job_id: job, company, url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${job}`,
          fields: [{ name: "first_name", value: "Ada" }], privacy_epoch: 0, account_version: 0,
          expires_at: new Date(Date.now() + DAY).toISOString(),
          resume_sha256: "d".repeat(64), // OWNER RULE 2026-10-26 (20261026210016): an approved application binds its resume
        };
        const h = await pg.sql(`select public.career_apply_payload_hash($j$${JSON.stringify(p)}$j$::jsonb)`);
        const r = await svc.rpc("career_apply_enqueue", { p_payload: p, p_hash: h, p_approval: h, p_daily: 25 });
        assertNode.equal(r.error, null, `enqueue ${job}: ${r.error?.message}`);
      }
      await pg.sql(`set session_replication_role = replica;
        update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"') where user_id = '${u}' and job_id = 'tampered';
        set session_replication_role = origin;`);
      if (await bridgeInstalled(pg)) {
        // The bridge's binding row, as its card tap writes it (its approval row is not this test's subject).
        await pg.sql(`set session_replication_role = replica;
          insert into career_message_approval_private.cloud_bound_jobs (job_row_id, approval_id, user_id, card_id, item_index)
          select id, gen_random_uuid(), user_id, gen_random_uuid(), 0 from public.career_apply_jobs where user_id = '${u}' and job_id = 'bound';
          set session_replication_role = origin;`);
      }
      return u;
    };
    // What the person's own claim hands out, by job.
    const claim = async (pg: Pg, u: string) => {
      const r = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 6, p_source: "own_computer" });
      assertNode.equal(r.error, null, r.error?.message);
      return (r.data as { job_id: string }[]).map((j) => j.job_id).sort();
    };
    const stateOf = async (pg: Pg, u: string, job: string) =>
      await pg.sql(`select state from public.career_apply_jobs where user_id = '${u}' and job_id = '${job}'`);
    // Both halves, by behaviour: the tampered row is closed as not sent; the bound row stays the cloud's.
    const whole = async (pg: Pg, label: string) => {
      assertNode.deepEqual(await missing(pg), [], label);
      const u = await scene(pg);
      const bridge = await bridgeInstalled(pg);
      // Without the bridge nothing is bound: the third row is an ordinary approved application.
      assertNode.deepEqual(await claim(pg, u), bridge ? ["ok"] : ["bound", "ok"], `${label}: the claim hands out only approved, unbound rows`);
      assertNode.equal(await stateOf(pg, u, "tampered"), "not_submitted", label);
      if (bridge) assertNode.equal(await stateOf(pg, u, "bound"), "queued", label);
    };
    const migration = (name: string) => Deno.readTextFile(`${MIG}/${name}`);

    await t.step("A no bridge (CI's order): G3 whole; the reconcile installs the ledger's two", async () => {
      const pg = await startPg();
      try {
        assertNode.equal(await bridgeInstalled(pg), false);
        await whole(pg, "A");
      } finally {
        await pg.stop();
      }
    });

    await t.step("B the bridge after the ledger: G3 lost until the reconcile; the launch script reconciles and verifies", async () => {
      const pg = await startPg();
      try {
        await pg.sql(await migration(BRIDGE));
        assertNode.equal(await bridgeInstalled(pg), true);
        // The losing order, as it stands with nothing after the bridge.
        const lost = await missing(pg);
        assertNode.ok(lost.includes("career_apply_claim_own: no approval re-check"), JSON.stringify(lost));
        assertNode.ok(lost.includes("career_apply_cloud_refusal: no approval re-check"), JSON.stringify(lost));
        assertNode.ok(lost.includes("career_apply_cloud_refusal: not on the one ledger"), JSON.stringify(lost));
        const u = await scene(pg);
        assertNode.deepEqual(await claim(pg, u), ["ok", "tampered"], "B (losing): the changed application is handed to a drive");
        // The reconcile restores G3 and keeps the bridge.
        assertNode.equal(await pg.sql(`select public.career_apply_reconcile_bridge()`), "merged");
        await whole(pg, "B (reconciled)");
      } finally {
        await pg.stop();
      }
    });

    await t.step("B' the losing order through the owner's launch script (--pending, only the bridge new)", async () => {
      const pg = await startPg();
      try {
        // The ledger table as a live project with everything but the bridge applied has it.
        const files = [...Deno.readDirSync(MIG)].map((e) => e.name).filter((f) => f.endsWith(".sql") && f !== BRIDGE).sort();
        const rows = await Promise.all(files.map(async (f) => `('${f}', '${await sha256(`${MIG}/${f}`)}')`));
        await pg.sql(`create table if not exists public.upmore_migration_ledger(filename text primary key, sha256 text not null,
          applied_at timestamptz not null default now());
          insert into public.upmore_migration_ledger(filename, sha256) values ${rows.join(",")};`);
        const out = await new Deno.Command("bash", {
          args: [`${ROOT}/scripts/launch/apply-rails-and-seed.sh`, "--pending"], cwd: ROOT, stdout: "piped", stderr: "piped",
          env: { SUPABASE_DB_URL: `postgresql://postgres@/postgres?host=${pg.host}&port=${pg.port}` },
        }).output();
        const said = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
        assertNode.equal(out.code, 0, said);
        assertNode.match(said, new RegExp(`standalone bridge migration: ${BRIDGE}`), said);
        assertNode.equal(await bridgeInstalled(pg), true);
        await whole(pg, "B' (launch script)");
      } finally {
        await pg.stop();
      }
    });

    await t.step("C filename order with the bridge: the reconcile file restores the bridge's half", async () => {
      const pg = await startPg({ includeBridge: true });
      try {
        assertNode.equal(await bridgeInstalled(pg), true);
        await whole(pg, "C");
        // What filename order alone would leave (the ledger's two over the bridge): the person's claim picks the cloud-bound
        // row too; the bridge's own trigger refuses it, so the whole claim fails and nothing of theirs is handed out.
        await pg.sql(await migration(LEDGER));
        assertNode.ok((await missing(pg)).includes("career_apply_claim_own: takes cloud-bound jobs"));
        const u = await scene(pg);
        const r = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 6, p_source: "own_computer" });
        assertNode.match(String(r.error?.message), /cloud immutable boundary/, "C (ledger last): the person's own claim fails outright");
        assertNode.equal(await stateOf(pg, u, "ok"), "queued", "C (ledger last): not even the approved, unbound row goes");
        assertNode.equal(await pg.sql(`select public.career_apply_reconcile_bridge()`), "merged");
        await whole(pg, "C (reconciled)");
      } finally {
        await pg.stop();
      }
    });

    await t.step("D the bridge's rollback after the ledger: G3 lost until the reconcile restores the ledger's two", async () => {
      const pg = await startPg({ includeBridge: true });
      try {
        await pg.sql(await Deno.readTextFile(ROLLBACK));
        assertNode.equal(await bridgeInstalled(pg), false);
        const lost = await missing(pg);
        assertNode.ok(lost.includes("career_apply_claim_own: no approval re-check"), JSON.stringify(lost));
        assertNode.equal(await pg.sql(`select public.career_apply_reconcile_bridge()`), "ledger");
        await whole(pg, "D (reconciled)");
      } finally {
        await pg.stop();
      }
    });
  },
});
