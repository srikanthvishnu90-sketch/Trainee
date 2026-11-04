// Billing by text and research answers end to end (battery 2026-10-29), sampled from the generated scenarios
// (tests/architect/scenarios/billing-research-generator.ts; the full ~10,000 run on the pure turns in
// tests/architect/scenarios-billing-research.test.ts), on real Postgres 16 with every migration.
//
// BILLING through the REAL production handler (agent-chat handler-career.ts handleChat; harness tests/flow/handler.ts):
// each scenario is a fresh person whose user_subscriptions row is the scenario's state, texting the scenario's script.
// Stripe is answered at the HTTP boundary (the handler's own adapter, stripeFromEnv, reads a fake key from the
// environment; "not configured" runs without it) in the scenario's mode, and every call is recorded. After each
// scenario: Stripe's cancel was called exactly as the script and state demand, each call carrying the hash of the payload
// the ask showed (read back from the ask's own reply); the row says ending exactly when Stripe confirmed; every billing
// reply's numbers, dates and links come from the row or Stripe's answer; no retention pitch, no refund promise; a control
// is never taken by billing; the key is in no reply, no log line and no table.
//
// RESEARCH on the product's report store: researchTurn over a fake web and a scripted model, the report stored in
// channel_artifacts (research_report_store.ts artifactReportStore over supabase-js to the PostgREST double) and served
// back by trainee-report's handler at its signed link (another person's link, or a forged one, is a 404); then every
// part checked as in the pure battery (tests/architect/scenarios/research-check.ts). A report with no thread to file
// under is not saved, and the answer says so.
//
// No model (CAREER_BRAIN, ANTHROPIC_API_KEY unset), no Stripe, no web: every host but the Supabase double and the fake
// Stripe is refused and listed. Instants are fixed where the product takes `now` (the report store and the report),
// nothing depends on the time of day, and every environment variable set here is restored. About 220 handler turns (130
// billing scenarios) and 58 research scenarios, about 40 s.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import {
  type BillingScenario, billingScenarios, cancellable, fakeStripeFetch, type ResearchScenario, researchScenarios, type StripeCall, STRIPE_KEY, type StripeMode,
  REPORT_SECRET,
} from "./scenarios/billing-research-generator.ts";
import { checkResearch, FIXED } from "./scenarios/research-check.ts";
import { factsOk, REFUND_PROMISE, RETENTION, stripeLinks } from "./scenarios/billing-check.ts";
import { cancelHash, type Subscription } from "../../supabase/functions/_shared/career_billing.ts";
import { artifactReportStore, type ReportStore } from "../../supabase/functions/_shared/research_report_store.ts";
import { handleReport } from "../../supabase/functions/trainee-report/handler.ts";
import { UNSUPPORTED, NO_SOURCES } from "../../supabase/functions/_shared/research_reply.ts";

const CI = Deno.env.get("CI") === "true";
const uidOf = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${(0xb1000000 + i).toString(16).padStart(12, "0")}`;
const lit = (v: unknown) => v === null || v === undefined ? "null" : typeof v === "boolean" || typeof v === "number" ? String(v) : `$q$${v}$q$`;

// The sample: every row state and Stripe mode, every script kind, controls included; ~170 turns.
function sampleBilling(): BillingScenario[] {
  const all = billingScenarios(20261029, 7000);
  const out: BillingScenario[] = [];
  const seen = new Map<string, number>();
  for (const s of all) {
    const key = `${s.rowKind}|${s.mode}|${s.script.kind}`;
    if ((seen.get(key) ?? 0) >= 1) continue;
    seen.set(key, 1);
    out.push(s);
    if (out.length >= 130) break;
  }
  return out;
}

Deno.test({
  name: "billing and research scenarios end to end: the real handler on Postgres (billing), the report store and trainee-report (research)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const BILL = sampleBilling();
    const RES = researchScenarios(20261031, 400).filter((_, i) => i % 7 === 0).slice(0, 60);
    const people: Record<string, string> = {};
    for (let i = 1; i <= BILL.length + 2; i++) people[`tok-br-${i}`] = uidOf(i);
    const unset = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "CAREER_RESEARCH_REPLY", "TRAINEE_REPORT_SECRET"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    const pg: Pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const logged: string[] = [];
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      await pg.sql(Object.values(people).map((id) => `insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`).join("\n"));
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, people);
      // Nothing leaves the machine: the double answers the project, the fake answers Stripe, anything else is refused.
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      const calls: StripeCall[] = [];
      const cur = { mode: "ok" as StripeMode, row: null as Subscription | null, invoices: [] as BillingScenario["invoices"] };
      const stripe = fakeStripeFetch({ mode: () => cur.mode, invoices: () => cur.invoices, periodEnd: () => cur.row?.current_period_end ?? null, calls, instantTimeout: true });
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.stripe.com") return await stripe(req);
        outbound.push(`${req.method} ${u.host}${u.pathname}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const failures: string[] = [];
      const counts = { billingScenarios: 0, billingTurns: 0, research: 0 };

      await t.step(`billing: ${BILL.length} sampled scenarios through the handler, every row state x Stripe mode x script`, async () => {
        for (const [i, sc] of BILL.entries()) {
          const id = uidOf(i + 1), chat = h!.chat(`tok-br-${i + 1}`);
          const name = `#${sc.id} [${sc.rowKind}/${sc.mode}/${sc.script.kind}]`;
          const fail = (m: string) => failures.push(`${name} ${m}`);
          cur.mode = sc.mode; cur.invoices = sc.invoices; cur.row = sc.row ? { ...sc.row } : null;
          if (sc.mode === "unconfigured") Deno.env.delete("STRIPE_SECRET_KEY"); else Deno.env.set("STRIPE_SECRET_KEY", STRIPE_KEY);
          if (sc.row) {
            const r = sc.row;
            await pg.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end)
              values ('${id}', ${lit(r.status)}, ${lit(r.plan)}, ${lit(r.price_cents)}, ${lit(r.current_period_start)}, ${lit(r.current_period_end)}, ${lit(r.stripe_customer_id)}, ${lit(r.stripe_subscription_id)}, ${lit(r.cancel_at_period_end ?? false)});`);
          }
          const before = calls.length;
          const turns: { said: string; reply: string; intent: string | null; meta: any; posts: number }[] = [];
          const say = async (m: string) => {
            const n0 = calls.filter((c) => c.method === "POST").length;
            const r = await chat.say(m);
            counts.billingTurns++;
            if (r.status !== 200 && !(r.status === 400 && !m.trim())) fail(`${JSON.stringify(m)}: HTTP ${r.status} ${r.reply.slice(0, 120)}`);
            turns.push({ said: m, reply: r.reply, intent: r.intent, meta: r.body?.meta, posts: calls.filter((c) => c.method === "POST").length - n0 });
            return r;
          };
          const s = sc.script;
          const configured = sc.mode !== "unconfigured";
          let expectPosts = 0;
          if (s.kind === "ask") {
            const r = await say(s.ask);
            const billing = /^career_billing/.test(String(r.intent));
            if (s.askKind === null && billing) fail(`a control taken by billing: ${JSON.stringify(s.ask)} -> ${r.reply}`);
            if (s.askKind !== null && !billing) fail(`not answered by billing: ${JSON.stringify(s.ask)} -> ${r.intent}: ${r.reply.slice(0, 160)}`);
          } else {
            const ask = await say(s.ask);
            if (!/^career_billing/.test(String(ask.intent))) fail(`cancel ask not taken: ${JSON.stringify(s.ask)} -> ${ask.intent}`);
            if (s.kind === "answer") { await say(s.answer); expectPosts = s.cls === "yes" && cancellable(sc.row) && configured ? 1 : 0; }
            else if (s.kind === "yes_twice") { await say(s.answer); await say(s.answer); expectPosts = cancellable(sc.row) && configured ? (["ok", "unconfirmed"].includes(sc.mode) ? 1 : 2) : 0; }
            else if (s.kind === "changed") {
              if (sc.row) { await pg.sql(`update public.user_subscriptions set current_period_end = '2027-03-31T10:00:00Z' where user_id = '${id}'`); cur.row = { ...cur.row!, current_period_end: "2027-03-31T10:00:00.000Z" }; }
              const r = await say(s.answer);
              if (cancellable(sc.row) && !/changed since I asked/.test(r.reply)) fail(`a changed plan not re-asked: ${r.reply.slice(0, 160)}`);
            } else { await say(s.no); await say(s.answer); }
          }
          const mine = calls.slice(before);
          const posts = mine.filter((c) => c.method === "POST");
          if (posts.length !== expectPosts) fail(`Stripe cancel called ${posts.length} times, want ${expectPosts}: ${turns.map((x) => `${JSON.stringify(x.said)} -> ${x.reply.slice(0, 100)}`).join(" | ")}`);
          // The key on the cancel is the hash of the payload the ask showed (its reply's meta), which is the row's.
          // (The row's period end comes back from the database in its own text form, so the payload is compared by instant.)
          const bc = turns[0]?.meta?.billing_cancel ?? null;
          const shown = bc?.hash ?? null;
          const want = bc ? await cancelHash(bc.subscription_id, bc.period_end) : null;
          if (bc && (shown !== want || bc.subscription_id !== sc.row?.stripe_subscription_id || (bc.period_end === null) !== (sc.row?.current_period_end == null) ||
            (bc.period_end !== null && Date.parse(bc.period_end) !== Date.parse(sc.row!.current_period_end!)))) fail(`the ask showed a payload that is not the row's: ${JSON.stringify(bc)}`);
          if (posts.length && !bc) fail("a cancel with no ask shown");
          for (const c of posts) if (c.idem !== want || c.body !== "cancel_at_period_end=true" || c.auth !== `Bearer ${STRIPE_KEY}`) fail(`cancel call ${c.path} idem=${c.idem} body=${c.body}`);
          const marked = await pg.sql(`select coalesce((select cancel_at_period_end::text from public.user_subscriptions where user_id = '${id}'), 'none')`);
          const wantMarked = sc.row ? (sc.row.cancel_at_period_end === true || (posts.length > 0 && sc.mode === "ok") ? "true" : "false") : "none";
          if (marked !== wantMarked) fail(`row cancel_at_period_end ${marked}, want ${wantMarked}`);
          const links = stripeLinks(sc.invoices);
          for (const x of turns) {
            if (!/^career_billing/.test(String(x.intent))) continue;
            if (/^Done/.test(x.reply) && !(x.posts === 1 && sc.mode === "ok")) fail(`"Done" without Stripe's confirmation: ${x.reply}`);
            if (x.posts && ["5xx", "timeout", "malformed"].includes(sc.mode) && /nothing was cancelled/i.test(x.reply)) fail(`"nothing was cancelled" after no clear answer: ${x.reply}`);
            if (RETENTION.test(x.reply)) fail(`retention words: ${x.reply}`);
            if (REFUND_PROMISE.test(x.reply)) fail(`a refund promised: ${x.reply}`);
            if (x.reply.includes(STRIPE_KEY)) fail("the key in a reply");
            const bad = factsOk(x.reply, [sc.row, cur.row], sc.invoices, links);
            if (bad) fail(`${JSON.stringify(x.said)}: ${bad}: ${x.reply}`);
          }
          counts.billingScenarios++;
        }
        Deno.env.delete("STRIPE_SECRET_KEY");
        const dump = await pg.sql(`select coalesce(string_agg(t::text, E'\\n'), '') from (select meta::text as t from public.agent_messages union all select content from public.agent_messages union all select row(s.*)::text from public.user_subscriptions s) t`);
        if (dump.includes(STRIPE_KEY) || dump.includes("scenarioKEY")) failures.push("the Stripe key is in a table");
        for (const l of logged) if (l.includes(STRIPE_KEY) || l.includes("scenarioKEY")) { failures.push(`the Stripe key in a log line: ${l.slice(0, 160)}`); break; }
      });

      await t.step(`research: ${RES.length} sampled scenarios, reports stored in channel_artifacts and served by trainee-report at their signed link`, async () => {
        const owner = uidOf(BILL.length + 1), other = uidOf(BILL.length + 2);
        const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: h!.double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
        const real = artifactReportStore(admin, { now: () => FIXED });
        const env = { get: (k: string) => k === "TRAINEE_REPORT_SECRET" ? REPORT_SECRET : undefined };
        let stored = 0;
        for (const [i, sc] of RES.entries()) {
          const thread = (await pg.sql(`insert into public.agent_threads (user_id, title) values ('${owner}', 'research ${i}') returning id`)).split("\n")[0].trim();
          // The scenario's store mode over the real store: a write that fails, a read-back that differs.
          const store: ReportStore = sc.store === "fail" ? { put: async () => { throw new Error("store unavailable"); }, get: real.get }
            : sc.store === "corrupt" ? { put: real.put, get: async (u, id) => { const d = await real.get(u, id); return d ? { ...d, bytes: d.bytes.slice(1) } : null; } }
            : real;
          // Every fifth scenario files under no thread: the store refuses it, and the answer must say the report wasn't saved.
          const noThread = i % 5 === 4;
          const res = await checkResearch(sc, {
            store, userId: owner, threadId: noThread ? null : thread,
            readReport: async (_id, url) => {
              const r = await handleReport(new Request(url), { env, store: () => artifactReportStore(admin, { now: () => FIXED }) });
              if (r.status !== 200) return null;
              // The same link for another person, or with its signature changed, is nothing.
              const u = new URL(url);
              const forged = new URL(url); forged.searchParams.set("s", "0".repeat(32));
              const theirs = new URL(url); theirs.searchParams.set("u", other);
              for (const bad of [forged, theirs]) if ((await handleReport(new Request(bad), { env, store: () => artifactReportStore(admin, { now: () => FIXED }) })).status !== 404) failures.push(`#${sc.id} a forged report link served: ${bad}`);
              if (!u.pathname.includes("/trainee-report/")) failures.push(`#${sc.id} report link outside trainee-report: ${url}`);
              return await r.text();
            },
          });
          failures.push(...res.fails);
          const reply = res.reply;
          if (reply?.report) stored++;
          const answered = reply && !reply.answer.startsWith(NO_SOURCES) && !reply.answer.startsWith(UNSUPPORTED);
          if (answered && noThread && sc.store === "ok" && (reply!.report || !/couldn't save the full report/.test(reply!.answer))) failures.push(`#${sc.id} a report with no thread: ${reply!.answer}`);
          counts.research++;
        }
        const rows = Number(await pg.sql(`select count(*) from public.channel_artifacts where user_id = '${owner}'`));
        if (rows < stored) failures.push(`${stored} report links but ${rows} stored rows`);
        if (stored < 5) failures.push(`only ${stored} reports stored: the sample does not reach the store`);
      });

      await t.step("nothing left the machine; under two minutes", () => {
        const secs = (Date.now() - started) / 1000;
        realLog.log(`flow-scenarios-billing-research: billing ${counts.billingScenarios} scenarios / ${counts.billingTurns} handler turns, research ${counts.research} scenarios, in ${secs.toFixed(1)} s; refused: ${outbound.join("; ") || "none"}`);
        if (outbound.length) failures.push(`outbound requests: ${outbound.join(", ")}`);
        if (secs > 150) failures.push(`took ${secs.toFixed(0)} s`);
        assertNode.deepEqual(failures, [], failures.slice(0, 60).join("\n"));
      });
    } finally {
      Object.assign(console, realLog);
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
