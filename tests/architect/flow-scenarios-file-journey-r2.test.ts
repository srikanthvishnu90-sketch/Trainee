// The whole jobs-page journey, round 2, on real Postgres 16 (the flow harness: every migration in production order): ~80 seeded
// journeys from scenarios/file-journey-r2-generator.ts (10 or more of each kind: Telegram's list -> link -> phone sign-in -> list
// -> Apply -> Telegram's Confirm; the page and Telegram on the same posting; the list changing between draw and tap; a session
// expiring; two devices and a sign-out; rendering at scale; cross-site forms, planted session ids, other accounts' sessions,
// redirects; forwarded links tried by a stranger), each run through the real handler (handleFile), the real Telegram card path
// (sendJobCards, tapJob) and the deployed stores over supabase-js and the PostgREST double: supabaseFileStore (career_postings,
// career_apply_prepared, career_apply_jobs, career_apply_wanted, career_watch_kv), supabaseCardStore (the one-transaction card
// confirm), supabaseTapStore, supabaseSessionStore (trainee_file_sessions and trainee_file_logins: the session id's hash only,
// the caps counted in the database), supabaseConfirmedFacts. The person's phone and the texted code are a fake (no SMS, no
// network). Every check of scenarios-file-journey-r2-battery.ts runs after every request, against the database's own rows.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { PgConn } from "../flow/pgwire.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseFileStore, supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { supabaseTapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { supabaseCardStore } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { supabaseConfirmedFacts } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { startSession } from "../../supabase/functions/_shared/file_session.ts";
import type { PostingSpec, PrepKind, Scenario } from "./scenarios/file-journey-r2-generator.ts";
import { sample } from "./scenarios/file-journey-r2-generator.ts";
import { fakePhone } from "./file-session-fakes.ts";
import { envOf, eq, newReport, payloadOf, postOf, postsOf, printReport, runScenario, SCENARIOS, type Truth, V, type World, RESUME_FILE } from "./scenarios-file-journey-r2-battery.ts";

const CI = Deno.env.get("CI") === "true";
const PER_KIND = Number(Deno.env.get("FJ_PG_PER_KIND") ?? 10);
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };
const DAY = 86_400_000;

async function pgWorld(s: Scenario, pg: Pg, admin: unknown, n: number): Promise<World> {
  const clock = { now: Date.now() }; // the database stamps its own rows with now(); the handler's clock starts there and moves on its own
  const u = `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await pg.sql(`insert into auth.users (id, email) values ('${u}', 'fj${n}@example.test'); insert into public.profiles (id) values ('${u}');
    insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', ${lit(JSON.stringify({ epoch: 0, version: 0, paused: false, memory: { profile: { facts: [] } } }))}::jsonb);
    ${confirmedResumeSql(u, RESUME_FILE)}`);
  const posts = await postsOf(s.postings, u, 500 + n, clock.now);
  for (const p of posts) if (p.row) p.row.deadline = null; // career_postings has no deadline column: the deployed store never reads one
  const accounts: Record<string, string | null> = { [u]: `+1512556${String(1000 + n).slice(-4)}`, [V]: "+15125550199" };
  const phone = fakePhone(accounts);
  const sessions = supabaseSessionStore(admin);
  const base = supabaseFileStore(admin);
  const sqlTs = (v: string | null | undefined) => v ? `${lit(v)}::timestamptz` : "null";
  const insertRows = async (ps: typeof posts) => {
    const rows = ps.filter((p) => p.row).map((p) => { const r = p.row!; return `(${lit(r.job_id)}, ${lit(String(r.provider))}, ${lit(r.job_id.split(":")[1])}, ${lit(String(r.company).slice(0, 300))}, ${lit(String(r.title))}, ${lit(String(r.location ?? ""))}, ${lit(String(r.url))}, ${lit(String(r.description ?? ""))}, ${r.remote ? lit(r.remote) : "null"}, ${sqlTs(r.posted_at)}, ${sqlTs(r.first_seen_at)}, now(), ${sqlTs(r.closed_at)}, ${r.pay ? lit(r.pay) : "null"})`; });
    if (rows.length) await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, remote, posted_at, first_seen_at, last_seen_at, closed_at, pay) values ${rows.join(",\n")} on conflict (job_id) do nothing;`);
  };
  await insertRows(posts);
  const prepare = async (i: number, kind: PrepKind) => {
    const p = posts[i];
    if (!/^https:\/\//.test(p.url) || /linkedin|indeed|joinhandshake/.test(p.url)) return;
    const payload = payloadOf(p, kind, p.hashes.length + 1, clock.now, u);
    let row: { id: string; payload_hash: string };
    try {
      row = JSON.parse(await pg.sql(`begin; set local role authenticated;
select set_config('request.jwt.claim.sub', '${u}', true), set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: u, role: "authenticated" }))}, true);
select to_jsonb(public.career_apply_prepare_own(p_payload => ${lit(JSON.stringify(payload))}::jsonb, p_card_lines => array[${lit(String(payload.company))}]::text[])); commit;`));
    } catch { return; } // the database refuses (already applied for, a link it does not take): the world is what the database says
    await pg.sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.jobId)} and state in ('ready', 'shown') and id <> '${row.id}'`);
    p.hashes.push(row.payload_hash);
  };
  const elsewhere = async (i: number, state: string) => {
    const p = posts[i];
    const pl = JSON.stringify({ version: 1, user_id: u, job_id: p.jobId, company: p.job.company || "Employer", url: p.url, fields: [], recorded: "elsewhere" });
    try {
      if ((await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${u}' and job_id = ${lit(p.jobId)}`)) !== "0") return;
      await pg.sql(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, reason, attempts, claimed_at, lease_token)
        select '${u}', ${lit(p.jobId)}, ${lit(p.job.company || "Employer")}, ${lit(p.url)}, x.p, h, h, ${lit(state)}, null, ${state === "queued" ? "0, null, null" : "1, now(), gen_random_uuid()"}
        from (select ${lit(pl)}::jsonb as p) x, lateral (select public.career_apply_payload_hash(x.p) as h) y`);
    } catch { /* a link the database does not take: the world is what the database says */ }
  };
  const env = envOf(s);
  const deps: FileDeps = { store: base as FileStore, cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), events: null, facts: supabaseConfirmedFacts(admin), now: () => clock.now,
    env: { get: (k) => env[k] }, sessions, phone: phone.auth, userOfTelegram: async () => null };
  const json = async (q: string) => JSON.parse(await pg.sql(q) || "[]");
  const world: World = {
    userId: u, accounts, posts, deps, phone, sessions, clock, listId: null,
    async setList(refs) { if (world.listId) await base.rememberList(u, world.listId, refs); },
    prepare,
    async mutate(op, i, r) {
      const k = i % posts.length, p = posts[k];
      if (op === "close") { if (p.row) { p.row.closed_at = new Date(clock.now - 60_000).toISOString(); await pg.sql(`update public.career_postings set closed_at = ${lit(p.row.closed_at)}::timestamptz where job_id = ${lit(p.jobId)}`); } }
      else if (op === "reprepare") await prepare(k, p.spec.prep && p.spec.prep !== "secret" ? p.spec.prep : "plain");
      else if (op === "unprepare") await pg.sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.jobId)} and state in ('ready', 'shown')`);
      else if (op === "elsewhere") await elsewhere(k, ["queued", "driving", "submitted_unconfirmed", "failed"][Math.floor(r() * 4)]);
    },
    async addPosting() {
      const spec: PostingSpec = { n: posts.length + 101, company: "latin", title: "latin", desc: "plain", url: "greenhouse", logo: "none", hasRow: true, closed: false, deadlinePast: false, prep: "plain", app: null, wanted: false };
      const p = await postOf(spec, u, 500 + n, clock.now);
      posts.push(p);
      await insertRows([p]);
      await base.remember(u, p.ref, p.job, "text");
      await prepare(posts.length - 1, "plain");
      return posts.length - 1;
    },
    async truth(): Promise<Truth> {
      const list = (world.listId ? await base.recallList(u, world.listId) : null) ?? [];
      const preps = await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'payload', payload, 'hash', payload_hash) order by created_at desc, id), '[]') from public.career_apply_prepared where user_id = '${u}' and state in ('ready', 'shown')`) as { job_id: string; payload: Record<string, unknown>; hash: string }[];
      const apps = await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'url', url, 'state', state) order by created_at desc), '[]') from public.career_apply_jobs where user_id = '${u}'`) as { job_id: string; url: string; state: string }[];
      const approved = await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'n', n)), '[]') from (select job_id, count(*) as n from public.career_apply_prepared where user_id = '${u}' and state = 'approved' group by job_id) x`) as { job_id: string; n: number }[];
      const wantedUrls = await json(`select coalesce(json_agg(posting_key), '[]') from public.career_apply_wanted where user_id = '${u}'`) as string[];
      const prep: Truth["prep"] = new Map(), app = new Map<string, string | null>(), wanted = new Map<string, boolean>(), closed = new Map<string, boolean>();
      for (const p of posts) {
        const x = preps.find((y) => y.job_id === p.jobId);
        const fields = (x?.payload.fields ?? []) as { type?: string }[];
        prep.set(p.jobId, x ? { hash: x.hash, secret: fields.some((f) => f.type === "password"), dest: typeof x.payload.destination === "string" ? x.payload.destination : null } : null);
        app.set(p.jobId, (apps.find((a) => a.job_id === p.jobId) ?? apps.find((a) => a.url === p.url))?.state ?? null);
        wanted.set(p.jobId, await base.wanted(u, p.url, p.job));
        closed.set(p.jobId, !!p.row?.closed_at);
      }
      void wantedUrls;
      return { list, prep, app, wanted, closed, approvals: new Map(approved.map((a) => [a.job_id, Number(a.n)])) };
    },
    async sessionRows() {
      return (await json(`select coalesce(json_agg(json_build_object('user_id', user_id, 'revoked', revoked_at is not null, 'idHash', id_hash)), '[]') from public.trainee_file_sessions where user_id in ('${u}', '${V}')`)) as { user_id: string; revoked: boolean; idHash: string }[];
    },
    async vSession() { return await startSession(sessions, { userId: V, via: "phone", phone: accounts[V], telegramId: null, list: "ffffffffff", now: clock.now }); },
  };
  for (const p of posts) await base.remember(u, p.ref, p.job, "text");
  for (let i = 0; i < posts.length; i++) {
    const sp = posts[i].spec;
    if (sp.prep) await prepare(i, sp.prep);
    if (sp.app) await elsewhere(i, sp.app === "needs_user" ? "needs_user" : sp.app);
    if (sp.wanted && /^https:\/\//.test(posts[i].url)) await base.want(u, posts[i].job, clock.now).catch(() => null);
  }
  void DAY;
  return world;
}

Deno.test({ name: `file journey r2 on real Postgres: ${PER_KIND} or more journeys of each kind through handleFile, Telegram's card path and the deployed stores (sessions, cards, applications, the wanted queue)`, sanitizeOps: false, sanitizeResources: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const slow: Pg = await startPg();
  const conn = await PgConn.connect({ host: slow.host, port: slow.port });
  const pg: Pg = { ...slow, async sql(text: string) {
    try { return (await conn.query(text.replace(/\\g \/dev\/null/g, ";"))).map((r) => r.map((v) => v ?? "").join("|")).join("\n").trim(); }
    catch (e) { await conn.query("rollback").catch(() => {}); throw e; }
  } };
  const rep = newReport();
  const realFetch = globalThis.fetch;
  try {
    const URL_ = "http://supabase.test", KEY = ["service", "test", "key"].join("-");
    const double = postgrestDouble(pg, { url: URL_, serviceKey: KEY, users: {} });
    const admin = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    await pg.sql(`insert into auth.users (id, email) values ('${V}', 'fj-other@example.test'); insert into public.profiles (id) values ('${V}');`);
    const outside: string[] = [];
    globalThis.fetch = ((x: string | URL | Request) => { outside.push(String(x instanceof Request ? x.url : x)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    // Up to 8 postings a journey (each request is dozens of real round trips), at least PER_KIND of each kind, plus one list longer than
    // the page (the first 30 of it, said on the page and in Telegram).
    const kinds = [...new Set(SCENARIOS.map((x) => x.kind))];
    const picked: Scenario[] = [];
    for (const k of kinds) picked.push(...sample(SCENARIOS.filter((x) => x.kind === k && x.postings.length <= 8), PER_KIND, 3030 + k.length));
    picked.push(...sample(SCENARIOS.filter((x) => x.kind === "render" && x.postings.length > 30), 1, 77));
    // And the rarer shapes, so the database sees each: a session id planted before the sign-in (random and another account's), a
    // redirect path naming another host, and Telegram's Confirm before the page's Apply on the same posting.
    const small = (x: Scenario) => x.postings.length <= 8 && !picked.includes(x);
    picked.push(...sample(SCENARIOS.filter((x) => small(x) && x.steps.some((st) => st.k === "open" && st.plant === "random")), 2, 5));
    picked.push(...sample(SCENARIOS.filter((x) => small(x) && x.steps.some((st) => st.k === "open" && st.plant === "other_account")), 2, 6));
    picked.push(...sample(SCENARIOS.filter((x) => small(x) && x.steps.some((st) => st.k === "open" && st.path !== "plain")), 2, 7));
    picked.push(...sample(SCENARIOS.filter((x) => small(x) && x.kind === "both_channels" && x.steps.findIndex((st) => st.k === "tg_confirm") < x.steps.findIndex((st) => st.k === "apply")), 4, 8));
    const only = Deno.env.get("FJ_ONLY");
    const run = only ? SCENARIOS.filter((x) => only.split(",").includes(String(x.id))) : picked;
    const started = Date.now();
    let n = 0;
    for (const s of run) await runScenario(s, await pgWorld(s, pg, admin, ++n), rep, { pg: true });
    console.log(`[file-journey-r2] Postgres run: ${run.length} journeys in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    eq(outside, [], "nothing left the machine but the PostgREST double");
    eq(double.log.filter((l) => /unsupported/.test(l.error ?? "")), [], "every call the stores made is one the double (and PostgREST) answers");
  } finally {
    globalThis.fetch = realFetch;
    conn.close();
    await slow.stop();
  }
  const failed = printReport("real Postgres", rep);
  if (!Deno.env.get("FJ_ONLY")) for (const [k, min] of [["phone sign-ins", 60], ["telegram lists", 70], ["telegram confirm duplicate", 2], ["csrf refused", 2], ["foreign session refused", 2], ["apply on an ended session", 5], ["fixation checked", 2], ["telegram confirm confirmed", 2]] as const) {
    if ((rep.counts[k] ?? 0) < min) throw new Error(`liveness on Postgres: "${k}" reached only ${rep.counts[k] ?? 0} times (want ${min})`);
  }
  if (!Deno.env.get("FJ_ONLY") && (rep.counts["apply (plain form) approved"] ?? 0) + (rep.counts["apply (script) approved"] ?? 0) + (rep.counts["apply to all approved"] ?? 0) < 10) throw new Error("liveness on Postgres: fewer than 10 page approvals");
  eq(failed, 0, "every check held after every request, against the database's own rows");
} });
