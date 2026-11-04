// Apply flow round 3 on real Postgres 16 (the flow harness: every migration in production order): a seeded sample of the round's
// scenarios (scenarios/apply-r3-generator.ts; every one of them runs in memory in scenarios-apply-r3*.test.ts) through the real
// handler (handleFile) and Telegram's card path (tapJob: Apply, then the Confirm it offers), over the deployed stores and supabase-js
// against the PostgREST double: supabaseFileStore (career_postings, career_apply_prepared, career_apply_jobs, career_apply_wanted,
// career_watch_kv, and career_apply_posting_sent for a posting sent another way), supabaseCardStore (career_apply_card_confirm_as: the
// one-transaction approval, career_apply_enqueue, career_apply_current, the resume guards), supabaseSessionStore, supabaseAccountStamp.
// Every check of scenarios-apply-r3-battery.ts runs after every request, against the database's own rows. Then the account deleted
// while an approved application waits in the queue: the queue row, the prepared rows and the sessions go with it, nothing is left
// to claim, and the page and Telegram approve nothing.
// The person's phone is a fake (no SMS, no network). Setup, not the person acting: accounts, a confirmed resume, postings, prepared
// rows written straight into career_apply_prepared (the resume guard still judges each), the other ways a posting was sent.
import { createClient } from "npm:@supabase/supabase-js@2";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { PgConn } from "../flow/pgwire.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { type FileDeps, handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { supabaseFileStore, supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { supabaseTapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { supabaseCardStore } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { hashTag, supabaseAccountStamp, supabaseConfirmedFacts, tapJob } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { SESSION_TTL_MS, startSession } from "../../supabase/functions/_shared/file_session.ts";
import { fakePhone, phonePost } from "./file-session-fakes.ts";
import { CATS, type Mut, sample, type Scenario } from "./scenarios/apply-r3-generator.ts";
import { eq, newReport, payloadOf, type Post, postOf, printReport, RESUME_A, runScenario, SCENARIOS, SECRET_LINK, stampOf, type Truth, V, type World } from "./scenarios-apply-r3-battery.ts";

const CI = Deno.env.get("CI") === "true";
const PER_CAT = Number(Deno.env.get("R3_PG_PER_CAT") ?? 12);
const DAY = 86_400_000;
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };

async function pgWorld(s: Scenario, pg: Pg, admin: unknown, n: number): Promise<World> {
  const u = `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const clock = { now: Date.now() - s.skew }; // the page's clock; the database's is its own (real) clock, s.skew ahead of the page's
  await pg.sql(`insert into auth.users (id, email) values ('${u}', 'r3-${n}@example.test'); insert into public.profiles (id) values ('${u}');
    insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', ${lit(JSON.stringify({ epoch: s.account.epoch, version: s.account.version, authority_version: s.account.authority, paused: s.account.paused, memory: { profile: { facts: [] } } }))}::jsonb);
    ${confirmedResumeSql(u, RESUME_A)}
    insert into public.career_resume_devices (user_id, sha256, at) values ('${u}', encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex'), now());`);
  // (career_resume_devices: the confirmed resume file the person's own computer prepares with, as career_apply_prepare_own records it.)
  const json = async (q: string) => JSON.parse(await pg.sql(q) || "null");
  const stamp = async () => stampOf(await json(`select value from public.career_watch_kv where user_id = '${u}' and key = 'career:account'`));
  const posts: Post[] = [];
  for (const p of s.posts) posts.push(await postOf(p, u, 300 + n, clock.now));
  const vPost = await postOf({ n: 999, company: "VSECRETR3 Corp", provider: "greenhouse", prep: null, elsewhere: null }, V, 300 + n, clock.now);
  const rows = [...posts, vPost].map((p) => `(${lit(p.jobId)}, ${lit(String(p.row.provider))}, ${lit(p.jobId.split(":")[1])}, ${lit(p.row.company!)}, ${lit(p.row.title!)}, ${lit(p.row.location!)}, ${lit(p.url)}, ${lit(p.row.description!)}, ${lit(p.row.posted_at!)}::timestamptz, ${lit(p.row.first_seen_at!)}::timestamptz, now())`);
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values ${rows.join(",\n")} on conflict (job_id) do nothing;`);
  const prepare = async (user: string, p: Post, spec: NonNullable<Post["spec"]["prep"]>) => {
    const a = await json(`select value from public.career_watch_kv where user_id = '${user}' and key = 'career:account'`);
    const st = stampOf(a) ?? { epoch: 0, version: 0, authority_version: 0, paused: false };
    const v = Number(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${user}' and job_id = ${lit(p.jobId)}`)) + 1;
    const payload = payloadOf(p, spec, v, { epoch: st.epoch, version: st.version, authority: st.authority_version }, clock.now, user, (await pg.sql(`select encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex')`)).trim());
    try {
      await pg.sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${user}' and job_id = ${lit(p.jobId)} and state in ('ready', 'shown');
        insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
        select '${user}', ${lit(p.jobId)}, ${lit(String(payload.company))}, ${lit(p.url)}, x.p, public.career_apply_payload_hash(x.p), array[${lit(String(payload.company).slice(0, 200) || "Employer")}]::text[], 'ready' from (select ${lit(JSON.stringify(payload))}::jsonb as p) x`);
    } catch (e) { if (Deno.env.get("R3_DEBUG")) console.log("prepare refused", String(e).slice(0, 300)); /* the database refuses it (the resume guard): the world is what the database says */ }
  };
  for (const p of posts) if (p.spec.prep) await prepare(u, p, p.spec.prep);
  const elsewhere = async (p: Post, how: "extension" | "alt_id") => {
    if ((await pg.sql(`select public.career_apply_posting_sent('${u}', ${lit(p.jobId)}, ${lit(p.url)}, null, true)`)) === "t") return;
    if (how === "extension") await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, success_text, tracker_record)
      values ('${u}', ${lit(p.spec.company.slice(0, 200))}, ${lit(p.row.title!)}, ${lit(p.variant)}, 'Thanks for applying (TEST r3)', true, '{}'::jsonb)`);
    else await pg.sql(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token)
      select '${u}', ${lit(`custom:alt:${p.jobId}`)}, ${lit(p.spec.company.slice(0, 200))}, ${lit(p.variant)}, x.p, h, h, 'submitted_unconfirmed', 1, now(), gen_random_uuid()
      from (select ${lit(JSON.stringify({ version: 1, user_id: u, job_id: `custom:alt:${p.jobId}`, company: p.spec.company, url: p.variant, fields: [], recorded: "elsewhere" }))}::jsonb as p) x, lateral (select public.career_apply_payload_hash(x.p) as h) y`);
  };
  for (const p of posts) if (p.spec.elsewhere) await elsewhere(p, p.spec.elsewhere);
  // The other account: its own list and a prepared application that carries its marker.
  await pg.sql(`insert into auth.users (id, email) values ('${V}', 'r3-other@example.test') on conflict do nothing; insert into public.profiles (id) values ('${V}') on conflict do nothing;`);
  if ((await pg.sql(`select count(*) from public.career_watch_kv where user_id = '${V}' and key = 'career:account'`)) === "0") {
    await pg.sql(`insert into public.career_watch_kv (user_id, key, value) values ('${V}', 'career:account', '{"epoch":0,"version":0,"memory":{"profile":{"facts":[]}}}'::jsonb); ${confirmedResumeSql(V, RESUME_A)}
      insert into public.career_resume_devices (user_id, sha256, at) values ('${V}', encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex'), now());`);
  }
  await prepare(V, vPost, { expiresIn: 7 * DAY, stamp: "current", fields: ["plain"], quarantine: "none" });
  const accounts: Record<string, string | null> = { [u]: `+1512557${String(1000 + n).slice(-4)}`, [V]: "+15125550144" };
  const phone = fakePhone(accounts);
  const sessions = supabaseSessionStore(admin);
  const store = supabaseFileStore(admin);
  const listId = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const p of posts) await store.remember(u, p.ref, p.job, "text");
  await store.rememberList(u, listId, posts.map((p) => p.ref));
  await store.remember(V, vPost.ref, vPost.job, "text");
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET_LINK, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
  const deps: FileDeps = { store, cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), events: null, facts: supabaseConfirmedFacts(admin), account: supabaseAccountStamp(admin),
    now: () => clock.now, env: { get: (k) => env[k] }, sessions, phone: phone.auth, userOfTelegram: async () => null };
  const t0 = clock.now;
  const tokens = { A: await startSession(sessions, { userId: u, via: "phone", phone: accounts[u], telegramId: null, list: listId, now: t0 }), B: await startSession(sessions, { userId: u, via: "phone", phone: accounts[u], telegramId: null, list: listId, now: t0 + 1000 }) };
  const vTagRow = await pg.sql(`select payload_hash from public.career_apply_prepared where user_id = '${V}' and job_id = ${lit(vPost.jobId)} and state in ('ready', 'shown') order by created_at desc limit 1`);
  let erased = false;
  return {
    u, posts, vRef: vPost.ref, vTag: hashTag(vTagRow || "0".repeat(64)), listId, deps, clock, skew: s.skew, sessions, tokens, expiry: { A: t0 + SESSION_TTL_MS, B: t0 + 1000 + SESSION_TTL_MS },
    dbNow: () => Date.now(),
    async truth(): Promise<Truth> {
      const preps = (await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'payload', payload, 'hash', payload_hash) order by created_at desc, id), '[]') from public.career_apply_prepared where user_id = '${u}' and state in ('ready', 'shown')`)) as { job_id: string; payload: Record<string, unknown>; hash: string }[];
      const apps = (await json(`select coalesce(json_agg(json_build_object('job_id', job_id, 'url', url, 'hash', payload_hash, 'payload', payload, 'state', state)), '[]') from public.career_apply_jobs where user_id = '${u}'`)) as Truth["apps"];
      const ext = (await json(`select coalesce(json_agg(posting_url), '[]') from public.extension_submission_reports where user_id = '${u}'`)) as string[];
      const prep = new Map<string, { hash: string; payload: Record<string, unknown> } | null>();
      for (const p of posts) { const x = preps.find((y) => y.job_id === p.jobId); prep.set(p.jobId, x ? { hash: x.hash, payload: x.payload } : null); }
      return { prep, apps, ext, account: await stamp(), resume: null, erased };
    },
    async mutate(m: Mut) {
      const upd = (expr: string) => pg.sql(`update public.career_watch_kv set value = ${expr} where user_id = '${u}' and key = 'career:account'`);
      if (m.m === "pause") await upd(`value || '{"paused": true}'::jsonb`);
      else if (m.m === "forget") await upd(`value || jsonb_build_object('epoch', coalesce((value->>'epoch')::bigint, 0) + 1)`);
      else if (m.m === "fence") await upd(`value || jsonb_build_object('version', coalesce((value->>'version')::bigint, 0) + 1, 'authority_version', coalesce((value->>'version')::bigint, 0) + 1)`);
      else if (m.m === "bump") await upd(`value || jsonb_build_object('version', coalesce((value->>'version')::bigint, 0) + 1)`);
      else if (m.m === "erase") { await pg.sql(`delete from public.profiles where id = '${u}'; delete from auth.users where id = '${u}'`); accounts[u] = null; erased = true; }
      else if (m.m === "elsewhere") await elsewhere(posts[m.i % posts.length], m.how);
      else if (m.m === "reprepare") {
        const p = posts[m.i % posts.length];
        if ((await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${u}' and job_id = ${lit(p.jobId)}`)) === "0") await prepare(u, p, { expiresIn: 7 * DAY, stamp: "current", fields: ["plain"], quarantine: "current" });
      }
      // replace_resume / delete_resume: the resume record's own flows are measured in memory (scenarios-apply-r3*.test.ts) and by
      // the resume batteries; here the sample leaves the resume as it is.
    },
  };
}

Deno.test({ name: `apply r3 on real Postgres: ${PER_CAT} scenarios of each category through handleFile, Telegram's Confirm and the deployed stores; then an account deleted while an approved application waits`, sanitizeOps: false, sanitizeResources: false, async fn() {
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
    const outside: string[] = [];
    globalThis.fetch = ((x: string | URL | Request) => { outside.push(String(x instanceof Request ? x.url : x)); return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    const picked: Scenario[] = [];
    for (const c of CATS) picked.push(...sample(SCENARIOS.filter((x) => x.cat === c && x.posts.length <= 40 && (c !== "resume")), c === "resume" ? 0 : PER_CAT, 4040 + c.length));
    const only = Deno.env.get("R3_ONLY");
    const run = only ? SCENARIOS.filter((x) => only.split(",").includes(String(x.id))) : picked;
    const started = Date.now();
    let n = 0;
    for (const s of run) await runScenario(s, await pgWorld(s, pg, admin, ++n), rep);
    console.log(`[apply r3] Postgres run: ${run.length} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    // The account deleted while an approved application waits in the queue (not yet claimed): everything of it goes, nothing is left
    // for a worker to claim, and neither its page session nor Telegram approves anything afterwards.
    const s0: Scenario = { id: 990_001, cat: "account", account: { epoch: 0, version: 5, authority: 0, paused: false }, skew: 0, steps: [],
      posts: [1, 2].map((k) => ({ n: k, company: `Deleted Co ${k}`, provider: "greenhouse" as const, prep: { expiresIn: 7 * DAY, stamp: "current" as const, fields: ["plain" as const], quarantine: "current" as const }, elsewhere: null })) };
    const w = await pgWorld(s0, pg, admin, ++n);
    const page = await (await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${w.tokens.A}` } }), w.deps)).text();
    const tag = /name="tag" value="([0-9a-f]{16})"/.exec(page)?.[1] ?? "";
    await handleFile(new Request("https://trainee.example/file", await phonePost({ t: w.tokens.A, action: "apply", ref: w.posts[0].ref, tag }, SECRET_LINK)), w.deps);
    eq((await w.truth()).apps.map((a) => a.state), ["queued"], "approved and waiting before the account is deleted");
    await w.mutate({ m: "erase" });
    eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${w.u}'`), "0", "the queue row went with the account");
    eq(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${w.u}'`), "0", "the prepared rows went with the account");
    eq(await pg.sql(`select count(*) from public.trainee_file_sessions where user_id = '${w.u}'`), "0", "the page's sessions went with the account");
    eq(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'queued' and user_id not in (select id from public.profiles)`), "0", "nothing of a deleted account is left to claim");
    const after = await handleFile(new Request("https://trainee.example/file", await phonePost({ t: w.tokens.A, action: "apply", ref: w.posts[1].ref, tag }, SECRET_LINK)), w.deps);
    eq(after.status >= 400, true, "the deleted account's page session approves nothing");
    const said: string[] = [];
    await tapJob({ userId: w.u, data: `jca:${w.posts[1].ref}`, messageId: null, deps: w.deps, send: { photo: async () => ({ ok: true }), text: async (a: { text: string }) => { said.push(a.text); return { ok: true, id: null }; } } as never });
    eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${w.u}'`), "0", "Telegram approves nothing for a deleted account");

    eq(outside, [], "nothing left the machine but the PostgREST double");
    eq(double.log.filter((l) => /unsupported/.test(l.error ?? "")), [], "every call the stores made is one the double (and PostgREST) answers");
  } finally {
    globalThis.fetch = realFetch;
    conn.close();
    await slow.stop();
  }
  const failed = printReport("real Postgres", rep);
  if (!Deno.env.get("R3_ONLY")) for (const [k, min] of [["rows offered for approval", 30], ["rows held back (not offered)", 10], ["queued via apply", 5], ["queued via applyall", 3], ["queued via tg_confirm", 2]] as const) {
    if ((rep.counts[k] ?? 0) < min) throw new Error(`liveness on Postgres: "${k}" reached only ${rep.counts[k] ?? 0} times (want ${min})`);
  }
  eq(failed, 0, "every check held after every request, against the database's own rows");
} });
