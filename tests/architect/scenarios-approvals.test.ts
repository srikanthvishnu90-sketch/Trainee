// Approvals at scale (owner rules, 2026-10-29): every approval path, fed ~10,000 generated answers
// (tests/architect/scenarios/approvals-generator.ts, seeded), approves exactly what the answer states or nothing.
//   - one clear "yes" approves exactly the batch shown, any size, each item bound to the hash it was shown with;
//   - a stated subset approves exactly that subset, or nothing (a form the path does not read asks again);
//   - anything ambiguous, deferred, negated, a question, a hedge, sarcasm, noise or another language approves nothing.
// Part 1 runs the real decision code of each path (cardTurn, outreachTurn, repliesTurn, billingTurn, employerAnswerAsk)
// over its in-memory store: every scenario, every path. Part 2 runs a seeded sample of 300+ through the production
// agent-chat handler (tests/flow/handler.ts) on real Postgres and reads the database's own rows. No model is called and
// nothing leaves the machine: every fetch that is not the PostgREST double is refused and counted.
import assertNode from "node:assert/strict";
import { type Scenario, generate, sample } from "./scenarios/approvals-generator.ts";
import { db as cardDb } from "./mass-submit-fixture.ts";
import { memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { ACTIONS_INTENT, actionHash, memoryRepliesStore, repliesTurn } from "../../supabase/functions/_shared/career_outreach_replies.ts";
import { type BillingStore, billingTurn, type Subscription } from "../../supabase/functions/_shared/career_billing.ts";
import { employerAnswerAsk } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261029, count: 10_000 });
const N = 5; // the batch shown on every batch path
const T0 = Date.parse("2026-10-27T15:00:00Z");

// ------------------------------------------------------------------------------------------------ the invariant
type Kind = "batch" | "single";
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
// null when the approval is right; else why not. `approved` is sorted.
export function violation(s: Scenario, approved: number[], n: number, kind: Kind): string | null {
  const none = approved.length === 0;
  switch (s.cls) {
    case "yes":
      return same(approved, all(n)) ? null : `a clear yes must approve exactly all ${n}`;
    case "yes_batch":
      // A batch word ("send them") answers a batch; on a single ask (a cancel) it may be read as yes or not at all.
      if (kind === "single") return none || same(approved, all(n)) ? null : "neither all nor nothing";
      return same(approved, all(n)) ? null : `a clear yes must approve exactly all ${n}`;
    case "subset": {
      if (kind === "single") return none ? null : "a numbered subset is not an answer to a single ask";
      const want = s.pick!(n);
      if (!want) return none ? null : "an unsatisfiable subset (out of range) must approve nothing";
      return none || same(approved, want) ? null : `must approve exactly [${want}] or nothing`;
    }
    default:
      return none ? null : "must approve nothing";
  }
}

type Report = { path: string; total: number; failures: Map<string, { s: Scenario; approved: number[]; why: string }[]>; missed: Map<string, number>; byCls: Record<string, number> };
function newReport(path: string): Report { return { path, total: 0, failures: new Map(), missed: new Map(), byCls: {} }; }
function grade(rep: Report, s: Scenario, approved: number[], n: number, kind: Kind) {
  rep.total++;
  rep.byCls[s.cls] = (rep.byCls[s.cls] ?? 0) + 1;
  approved = [...approved].sort((a, b) => a - b);
  const why = violation(s, approved, n, kind);
  if (why) {
    const k = `${s.cls}/${s.category}`;
    if (!rep.failures.has(k)) rep.failures.set(k, []);
    rep.failures.get(k)!.push({ s, approved, why });
  } else if (s.cls === "subset" && kind === "batch" && !approved.length && s.pick!(n)) {
    // Safe, but the stated subset was not read: counted (the path asked again), not a failure.
    rep.missed.set(s.category, (rep.missed.get(s.category) ?? 0) + 1);
  }
}
function print(rep: Report) {
  const failed = [...rep.failures.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[approvals] ${rep.path}: ${rep.total} scenarios (${Object.entries(rep.byCls).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
  for (const [k, xs] of rep.failures) {
    lines.push(`  FAIL ${k}: ${xs.length}`);
    for (const x of xs.slice(0, 3)) lines.push(`    ${JSON.stringify(x.s.text).slice(0, 90)} -> approved [${x.approved}] (${x.why})`);
  }
  const missed = [...rep.missed.entries()].sort((a, b) => b[1] - a[1]);
  if (missed.length) lines.push(`  subsets not read (approved nothing, asked again): ${missed.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(lines.join("\n"));
  return failed;
}
function assertClean(rep: Report) {
  const failed = print(rep);
  eq(failed, 0, `${rep.path}: ${failed} scenarios approved the wrong set (see the report above)`);
}

// ------------------------------------------------------------------------------------------------ the paths, in memory
// Applications on a card (career_apply_cards.ts cardTurn): the card shown, then the answer; what the queue took.
async function cardPath(s: Scenario): Promise<number[]> {
  const d = cardDb({ n: N });
  const shown = await d.say("show my applications");
  if (shown?.status !== "shown") throw new Error(`card not shown: ${shown?.reply}`);
  await d.say(s.text);
  const card = d.cards[0];
  // Each queued item is bound to the hash the card showed for it.
  for (const q of d.queue) {
    const item = card.items.find((i) => i.prepared_id === q.prepared_id)!;
    if (q.approval !== item.payload_hash) throw new Error(`queued under another hash: ${s.text}`);
  }
  return d.queue.map((q) => card.items.find((i) => i.prepared_id === q.prepared_id)!.n);
}

// Outreach drafts (career_outreach.ts outreachTurn): the batch is the thread's last word; what was approved, by hash.
async function outreachBatch(store: ReturnType<typeof memoryOutreachStore>, user: string, thread: string, n = N) {
  const ds: any[] = [];
  for (let i = 1; i <= n; i++) {
    const d: any = { n: i, recipient: { name: `Person ${i} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `p${i}@firm.example`, source: `list.csv, row ${i}` },
      subject: `Question ${i}`, body: `Hi ${i}, a short synthetic note.`, footer: `Sam\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null,
      gmail_thread: null, result: null, created_at: new Date(T0).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  await store.saveBatch(user, thread, ds, T0);
  store.setIntent(thread, OUTREACH_INTENT);
}
async function outreachPath(s: Scenario): Promise<number[]> {
  const store = memoryOutreachStore();
  await outreachBatch(store, "U", "TH");
  const handed: { n: number; approvalHash: string }[] = [];
  await outreachTurn({ message: s.text, userId: "U", threadId: "TH", now: T0 + 60_000, store, gmailConnected: async () => true, onApproved: async (_u, items) => { handed.push(...items); } });
  const approved = (await store.latestBatch("U")).filter((d) => d.status === "approved");
  for (const d of approved) {
    if (d.approved_hash !== d.hash || d.hash !== await payloadHash(messageOf(d))) throw new Error(`approved under another hash: ${s.text}`);
  }
  if (!same(handed.map((h) => h.n).sort((a, b) => a - b), approved.map((d) => d.n).sort((a, b) => a - b))) throw new Error(`handed to the rail != approved: ${s.text}`);
  return approved.map((d) => d.n);
}

// Follow-ups / scheduling replies / invites (career_outreach_replies.ts repliesTurn): the actions batch is the last word.
async function repliesPath(s: Scenario): Promise<number[]> {
  const store = memoryRepliesStore();
  const items = [];
  for (let i = 1; i <= N; i++) {
    const payload = { to: `c${i}@beta.example`, subject: `Re: note ${i}`, text: `Following up ${i}.` };
    items.push({ thread_id: `T${i}`, kind: "followup" as const, payload, hash: await actionHash("followup", payload), step: 1 });
  }
  await store.saveActions("U", items, T0);
  store.setIntent("CH", ACTIONS_INTENT);
  await repliesTurn({ message: s.text, userId: "U", chatThreadId: "CH", now: T0 + 60_000, store, tz: "America/Chicago" });
  const approved = store.dump().actions.filter((a: any) => a.status === "approved");
  for (const a of approved) if (a.approved_hash !== a.hash || a.hash !== await actionHash(a.kind, a.payload)) throw new Error(`approved under another hash: ${s.text}`);
  return approved.map((a: any) => a.n);
}

// Cancelling the plan (career_billing.ts billingTurn): "cancel my plan" shows the exact cancel; the answer; Stripe's calls.
async function billingPath(s: Scenario): Promise<number[]> {
  const sub: Subscription = { status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: "2026-11-27T15:00:00.000Z",
    stripe_customer_id: "cus_fake1", stripe_subscription_id: "sub_fake1", cancel_at_period_end: false };
  let last: Record<string, unknown> | null = null;
  const cancels: string[] = [];
  const store: BillingStore = { subscription: async () => sub, lastMeta: async () => last, markCancelling: async () => {} };
  const stripe = { async cancelAtPeriodEnd(id: string) { cancels.push(id); return { cancel_at_period_end: true, cancel_at: Date.parse(sub.current_period_end!) / 1000, current_period_end: Date.parse(sub.current_period_end!) / 1000 }; }, async listInvoices() { return []; } };
  const say = async (message: string) => { const r = await billingTurn({ message, userId: "u1", threadId: "t1", now: T0, store, stripe }); last = r ? { intent: r.intent, ...(r.meta ?? {}) } : null; return r; };
  const ask = await say("cancel my plan");
  if (!ask || !/Reply "yes" to cancel/.test(ask.reply)) throw new Error(`cancel not asked: ${ask?.reply}`);
  await say(s.text);
  return cancels.length ? [1] : [];
}

// "Is Acme where you work now?" (career_apply_chat.ts employerAnswerAsk): a "no" queues the posting (an external effect
// follows on approval); a "yes" records a fact about the person. Each only from a plain answer; anything else neither.
const PLAIN_NO = /^(?:no|nope|nah)$/, PLAIN_YES = /^(?:yes|yep|yeah|yup)$/;
function employerViolation(s: Scenario, ans: { kind: "yes" | "no" } | null): string | null {
  const base = s.base.trim().toLowerCase();
  if (ans?.kind === "no" && !(s.cls === "no" && /^(?:no|nope|nah)\b/.test(base) && !/thank/.test(base))) return "queued the posting on an answer that is not a plain no";
  if (ans?.kind === "yes" && s.cls !== "yes") return "recorded 'is my employer' on an answer that is not a clear yes";
  if (PLAIN_NO.test(base) && ans?.kind !== "no") return "a plain no must answer no";
  if (PLAIN_YES.test(base) && ans?.kind !== "yes") return "a plain yes must answer yes";
  return null;
}

// ------------------------------------------------------------------------------------------------ part 1: every scenario
const PATHS: [string, (s: Scenario) => Promise<number[]>, Kind, number][] = [
  ["apply cards (cardTurn)", cardPath, "batch", N],
  ["outreach drafts (outreachTurn)", outreachPath, "batch", N],
  ["follow-up/scheduling actions (repliesTurn)", repliesPath, "batch", N],
  ["billing cancel (billingTurn)", billingPath, "single", 1],
];
for (const [name, run, kind, n] of PATHS) {
  Deno.test(`approvals at scale, in memory: ${name}: ${SCENARIOS.length} scenarios approve exactly the stated set or nothing`, async () => {
    const rep = newReport(name);
    for (const s of SCENARIOS) grade(rep, s, await run(s), n, kind);
    assertClean(rep);
  });
}
Deno.test(`approvals at scale, in memory: employer question (employerAnswerAsk): ${SCENARIOS.length} scenarios answer only on a plain yes or no`, () => {
  const rep = newReport("employer question (employerAnswerAsk)");
  for (const s of SCENARIOS) {
    rep.total++;
    rep.byCls[s.cls] = (rep.byCls[s.cls] ?? 0) + 1;
    const ans = employerAnswerAsk(s.text);
    const why = employerViolation(s, ans);
    if (why) {
      const k = `${s.cls}/${s.category}`;
      if (!rep.failures.has(k)) rep.failures.set(k, []);
      rep.failures.get(k)!.push({ s, approved: ans?.kind === "no" ? [1] : [], why: `${why} (read: ${ans?.kind ?? "nothing"})` });
    }
  }
  assertClean(rep);
});
Deno.test("the generator is deterministic and covers every class", () => {
  const again = generate({ seed: 20261029, count: 10_000 });
  eq(again.map((s) => s.text), SCENARIOS.map((s) => s.text));
  const by = (c: string) => SCENARIOS.filter((s) => s.cls === c).length;
  for (const c of ["yes", "yes_batch", "no", "no_batch", "subset", "ambiguous", "noise"]) eq(by(c) > 100, true, `${c}: ${by(c)}`);
  eq(SCENARIOS.length >= 10_000, true);
});

// ------------------------------------------------------------------------------------------------ part 2: the real path
// A seeded sample through the production handler (agent-chat handler-career.ts handleChat) on real Postgres with CI's
// migration order: each scenario is a fresh person whose batch is shown by the chat itself, then answered by the
// scenario's text, then read back from the database's own rows (which items are approved, under which hash).
const CI = Deno.env.get("CI") === "true";
const E2E = { cards: 120, outreach: 80, replies: 60, billing: 40 }; // 300 scenarios, about 2.5 minutes
const RESUME_FILE = "%PDF-1.4\n% TEST approvals-at-scale resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
const uidOf = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${(0xa0000000 + i).toString(16).padStart(12, "0")}`;
const lit = (s: string) => `$q$${s}$q$`;

Deno.test({
  name: `approvals at scale, real handler on Postgres: ${Object.values(E2E).reduce((a, b) => a + b, 0)} sampled scenarios approve exactly the stated set (by hash) or nothing`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the approvals-at-scale handler test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]) Deno.env.delete(k);
    // A fake Stripe key (never a real one): the cancel call is answered below, at the HTTP boundary, and counted.
    Deno.env.set("STRIPE_SECRET_KEY", "sk_test_scenarios_fake_not_a_key");
    const total = Object.values(E2E).reduce((a, b) => a + b, 0);
    const people: Record<string, string> = {};
    for (let i = 1; i <= total; i++) people[`tok-ap-${i}`] = uidOf(i);
    const pg: Pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const outside: string[] = [];
    const stripeCancels: { user: string; idem: string }[] = [];
    try {
      await supabaseParity(pg);
      await pg.sql(Object.values(people).map((id) => `insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`).join("\n"));
      h = await careerHandler(pg, people);
      // Nothing leaves the machine: the PostgREST double answers the project; Stripe's cancel is answered here; anything
      // else (a model, any other host) is refused and counted.
      const viaDouble = globalThis.fetch;
      let stripeUser = "";
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const url = new URL(req.url);
        if (url.host === "supabase.test") return await viaDouble(req);
        if (url.host === "api.stripe.com" && req.method === "POST" && /^\/v1\/subscriptions\//.test(url.pathname)) {
          stripeCancels.push({ user: stripeUser, idem: req.headers.get("idempotency-key") ?? "" });
          return new Response(JSON.stringify({ cancel_at_period_end: true, cancel_at: Date.parse("2026-11-27T15:00:00Z") / 1000, current_period_end: Date.parse("2026-11-27T15:00:00Z") / 1000 }), { status: 200, headers: { "content-type": "application/json" } });
        }
        outside.push(`${req.method} ${url.host}${url.pathname}`);
        return new Response(JSON.stringify({ error: "network refused in this test" }), { status: 503, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      let next = 0;
      const person = () => { next++; return { token: `tok-ap-${next}`, id: uidOf(next) }; };
      const reports: Report[] = [];
      const started = Date.now();

      await t.step(`apply cards: ${E2E.cards} answers to a card of ${N}, through career_apply_card_answer_as`, async () => {
        const rep = newReport("apply cards (handler + Postgres)");
        for (const s of sample(SCENARIOS, E2E.cards, 101)) {
          const p = person();
          // Setup in one session: the confirmed resume, then N prepared applications stored by the person themselves
          // (career_apply_prepare_own as `authenticated` with their JWT subject, as PostgREST calls it; the database
          // computes each payload hash).
          const prepares: string[] = [];
          for (let i = 1; i <= N; i++) {
            const payload = { version: 1, user_id: p.id, job_id: `TEST-AP-${next}-${i}`, company: `Scenario Employer ${i}`, url: `https://jobs.lever.co/scen${i}/${next}`,
              fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "TEST-1" }], privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
            const lines = [`Scenario Employer ${i}: TEST Analyst`, "Email: t@example.test", `Sends to https://jobs.lever.co/scen${i}/${next}`];
            prepares.push(`select public.career_apply_prepare_own(p_payload => ${lit(JSON.stringify(payload))}::jsonb, p_card_lines => array(select jsonb_array_elements_text(${lit(JSON.stringify(lines))}::jsonb))) \\g /dev/null`);
          }
          await pg.sql(`${confirmedResumeSql(p.id, RESUME_FILE)}
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '${p.id}', true), set_config('request.jwt.claims', '{"sub":"${p.id}","role":"authenticated"}', true) \\g /dev/null
${prepares.join("\n")}
commit;`);
          eq(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${p.id}'`), String(N), "prepared by the person");
          const chat = h!.chat(p.token);
          const shown = await chat.say("show my applications");
          eq([shown.intent, shown.resultStatus], ["career_apply_card", "shown"], shown.reply);
          const ans = await chat.say(s.text);
          eq(ans.status === 200 || (ans.status === 400 && !s.text.trim()), true, `${JSON.stringify(s.text)}: ${ans.status} ${ans.reply}`);
          // Approved = queued jobs, each matched to the card item whose hash it carries (approval = payload = shown hash).
          const rows = JSON.parse(await pg.sql(`select json_build_object('bound', coalesce(json_agg((item->>'n')::int order by (item->>'n')::int), '[]'), 'jobs', (select count(*) from public.career_apply_jobs where user_id = '${p.id}'))
            from public.career_apply_cards c cross join jsonb_array_elements(c.items) item
            join public.career_apply_prepared pr on pr.id = (item->>'prepared_id')::uuid
            join public.career_apply_jobs j on j.user_id = pr.user_id and j.job_id = pr.job_id
            where c.user_id = '${p.id}' and j.approval_hash = item->>'payload_hash' and j.payload_hash = item->>'payload_hash'`));
          eq(rows.jobs, rows.bound.length, `${JSON.stringify(s.text)}: every queued job carries the hash its card showed`);
          grade(rep, s, rows.bound, N, "batch");
        }
        reports.push(rep);
        assertClean(rep);
      });

      await t.step(`outreach drafts: ${E2E.outreach} answers to a batch of ${N} emails, each approval bound to its message hash`, async () => {
        const rep = newReport("outreach drafts (handler + Postgres)");
        for (const s of sample(SCENARIOS, E2E.outreach, 202)) {
          const p = person();
          const batch = crypto.randomUUID();
          const values: string[] = [];
          for (let i = 1; i <= N; i++) {
            const d = { recipient: { name: `Person ${i} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `p${i}.${next}@firm.example`, source: `list.csv, row ${i}` },
              subject: `Question ${i}`, body: `Hi ${i}, a short synthetic note.`, footer: `Sam\n\n${OPT_OUT_LINE}` };
            const hash = await payloadHash(messageOf(d as any));
            values.push(`('${p.id}', '${batch}', ${i}, ${lit(JSON.stringify(d.recipient))}::jsonb, '${d.recipient.email}', ${lit(d.subject)}, ${lit(d.body)}, ${lit(d.footer)}, '${hash}')`);
          }
          await pg.sql(`insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash) values ${values.join(",")};`);
          const chat = h!.chat(p.token);
          const shown = await chat.say("show my outreach drafts");
          eq([shown.intent, shown.resultStatus], [OUTREACH_INTENT, "shown"], shown.reply);
          const ans = await chat.say(s.text);
          eq(ans.status === 200 || (ans.status === 400 && !s.text.trim()), true, `${JSON.stringify(s.text)}: ${ans.status} ${ans.reply}`);
          const ds: { n: number; status: string; hash: string; approved_hash: string | null; recipient: any; subject: string; body: string; footer: string }[] =
            JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('n', n, 'status', status, 'hash', hash, 'approved_hash', approved_hash, 'recipient', recipient, 'subject', subject, 'body', body, 'footer', footer) order by n), '[]') from public.career_outreach_drafts where user_id = '${p.id}'`));
          const approved = ds.filter((d) => d.status === "approved");
          for (const d of approved) {
            const h0 = await payloadHash(messageOf(d as any));
            eq([d.approved_hash, d.hash], [h0, h0], `${JSON.stringify(s.text)}: draft ${d.n} approved under the hash of the exact message shown`);
          }
          grade(rep, s, approved.map((d) => d.n), N, "batch");
        }
        reports.push(rep);
        assertClean(rep);
      });

      await t.step(`follow-up actions: ${E2E.replies} answers to ${N} follow-ups waiting for a yes, each by its payload hash`, async () => {
        const rep = newReport("follow-up actions (handler + Postgres)");
        for (const s of sample(SCENARIOS, E2E.replies, 303)) {
          const p = person();
          const batch = crypto.randomUUID();
          const sqls: string[] = [];
          for (let i = 1; i <= N; i++) {
            const payload = { to: `c${i}.${next}@beta.example`, subject: `Re: note ${i}`, text: `Following up ${i}.` };
            const hash = await actionHash("followup", payload);
            sqls.push(`with th as (insert into public.career_outreach_threads (user_id, provider, provider_thread, recipient_email, recipient_name, subject, sent_at)
                values ('${p.id}', 'gmail', 'gt-${next}-${i}', '${payload.to}', 'Contact ${i}', 'note ${i}', now() - interval '5 days') returning id)
              insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash) select '${p.id}', id, 'followup', 1, '${batch}', ${i}, ${lit(JSON.stringify(payload))}::jsonb, '${hash}' from th;`);
          }
          await pg.sql(sqls.join("\n"));
          const chat = h!.chat(p.token);
          const shown = await chat.say("show outreach approvals");
          eq([shown.intent, shown.resultStatus], [ACTIONS_INTENT, "shown"], shown.reply);
          const ans = await chat.say(s.text);
          eq(ans.status === 200 || (ans.status === 400 && !s.text.trim()), true, `${JSON.stringify(s.text)}: ${ans.status} ${ans.reply}`);
          const as: { n: number; status: string; hash: string; approved_hash: string | null; payload: any }[] =
            JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('n', n, 'status', status, 'hash', hash, 'approved_hash', approved_hash, 'payload', payload) order by n), '[]') from public.career_outreach_actions where user_id = '${p.id}'`));
          const approved = as.filter((a) => a.status === "approved");
          for (const a of approved) {
            const h0 = await actionHash("followup", a.payload);
            eq([a.approved_hash, a.hash], [h0, h0], `${JSON.stringify(s.text)}: action ${a.n} approved under its payload's hash`);
          }
          grade(rep, s, approved.map((a) => a.n), N, "batch");
        }
        reports.push(rep);
        assertClean(rep);
      });

      await t.step(`billing cancel: ${E2E.billing} answers to "cancel my plan", the cancel only on a clear yes, bound to its hash`, async () => {
        const rep = newReport("billing cancel (handler + Postgres)");
        for (const s of sample(SCENARIOS, E2E.billing, 404)) {
          const p = person();
          stripeUser = p.id;
          const sub = `sub_scen_${next}`;
          await pg.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id)
            values ('${p.id}', 'active', 'monthly', 1000, '2026-10-27T15:00:00Z', '2026-11-27T15:00:00Z', 'cus_scen_${next}', '${sub}');`);
          const chat = h!.chat(p.token);
          const ask = await chat.say("cancel my plan");
          eq(/Reply "yes" to cancel/.test(ask.reply), true, ask.reply);
          const ans = await chat.say(s.text);
          eq(ans.status === 200 || (ans.status === 400 && !s.text.trim()), true, `${JSON.stringify(s.text)}: ${ans.status} ${ans.reply}`);
          const mine = stripeCancels.filter((c) => c.user === p.id);
          const marked = await pg.sql(`select cancel_at_period_end from public.user_subscriptions where user_id = '${p.id}'`);
          eq(marked === "t", mine.length > 0, `${JSON.stringify(s.text)}: the row says ending exactly when Stripe was asked`);
          const shownHash = (ask.body?.meta?.billing_cancel?.hash ?? null) as string | null;
          for (const c of mine) eq(c.idem, shownHash, `${JSON.stringify(s.text)}: the cancel carries the hash of the exact payload shown`);
          grade(rep, s, mine.length ? [1] : [], 1, "single");
        }
        reports.push(rep);
        assertClean(rep);
      });

      console.log(`[approvals] real handler: ${reports.reduce((a, r) => a + r.total, 0)} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s; refused outside calls: ${outside.length}`);
      eq(outside, [], "no call left the machine (no model, no other host)");
    } finally {
      Deno.env.delete("STRIPE_SECRET_KEY");
      h?.restore();
      await pg.stop();
    }
  },
});
