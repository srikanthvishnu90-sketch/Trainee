// PEOPLE FINDING AND OUTREACH DRAFTS, ROUND 3, end to end (2026-11-02): a seeded sample of the round's scenarios
// (tests/architect/scenarios/people-drafts-r3.ts; all ~11,000 run through the pure turns in
// tests/architect/scenarios-people-drafts-r3.test.ts) sent through the PRODUCTION agent-chat handler
// (supabase/functions/agent-chat/handler-career.ts handleChat; harness tests/flow/handler.ts: real supabase-js over
// tests/flow/postgrest.ts, real Postgres 16 with every migration), each person their own account, judged by the
// database's own rows (career_outreach_drafts, career_intro_requests) and by what reached the writer:
//   A  names       non-Latin names, accents and honorifics, and two people with one name: drafted to the one asked for,
//                  with that one's row only, or asked which; never merged.
//   B  stale       one person on two lists read months apart, and on a page read this week: the newest title, or none.
//   C  injection   a stored row whose title or school speaks to the writer: never in the writer's prompt or a draft.
//   D  optout      opted out with someone else, or bounced, in a fresh search (discovered people) or a list: never drafted
//                  to, never an intro.
//   E  referral    a referral for another firm's job, or for a posting closed on the board: not drafted; an open one is.
//   F  alumni      "UT alumni at X": only whole-word matches, two schools said.
//   G  claims      a writer that praises work they never did, gives a title the row doesn't have, or claims a school or
//                  employer in common: nothing of it is stored.
//   H  addresses   a discovered person whose stored address is a guessed personal mailbox: never drafted to.
//   I  batch       150 people at one firm: 150 drafts, numbered once each, no cap; draft 120 approved by its number.
//   J  allowance   (D-046) no per-person AI allowance: a person who already used the day still gets every draft.
// The writer is a scripted stand-in at the Anthropic URL; any other host is refused and counted (asserted empty). Nothing is
// approved, queued or sent.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../flow/handler.ts";
import { generate } from "./scenarios/people-drafts-r3.ts";
import { memoryBudgetGate, resetLocalBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const N_USERS = 90;
const uid = (i: number) => `7d0f8f8e-6a43-4a49-9d2c-${String(900000000000 + i).padStart(12, "0")}`;
const TOKENS: Record<string, string> = Object.fromEntries(Array.from({ length: N_USERS }, (_, i) => [`tok-r3-${i}`, uid(i)]));
const FACTS = [{ id: "F-1", kind: "education", text: "BS Economics, DePaul University, Class of 2027", status: "confirmed" },
  { id: "F-2", kind: "experience", text: "Data analyst intern at Bravo Labs", status: "confirmed" }];
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase())))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sq = (s: string) => s.replace(/'/g, "''");

// ------------------------------------------------------------------------------------------------ the scripted writer
// Writes a short honest email from the row it is given; an adversary keyed by the recipient's name adds a claim (always,
// or only on the first try). Every prompt is kept, to check what reached it.
const ADV = new Map<string, { add: (row: Record<string, string>) => string; when: "always" | "first" }>();
const prompts: string[] = [];
function fakeModel(body: any): Response {
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  prompts.push(user);
  const f = (k: string) => { const v = new RegExp(`^- ${k}: (.*)$`, "m").exec(user)?.[1]?.trim() ?? ""; return v === "(not given)" ? "" : v; };
  const row = { name: f("name"), firm: f("firm"), title: f("title"), school: f("school"), topic: /ASK ABOUT[^\n]*\n- (.+)/.exec(user)?.[1]?.trim() ?? "" };
  const retry = /Your last version broke these rules/.test(user);
  const adv = ADV.get(row.name);
  const extra = adv && (adv.when === "always" || !retry) ? ` ${adv.add(row)}` : "";
  const ask = row.topic ? `I'd be grateful for 15 minutes to ask about ${row.topic.replace(/[.?!]+$/, "")}.` : "I'd be grateful for 15 minutes to hear how you got started.";
  const text = `Subject: A quick question\n\nHi ${row.name.split(/\s+/)[0] || "there"},\n\n${ask}${extra} Would you be open to a short call?`;
  return Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 50 } });
}

Deno.test({ name: "people drafts r3 end to end: names, stale titles, injected rows, opt-outs, referrals, alumni, claims, addresses and a long batch, through the real handler on real Postgres", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  resetLocalBudgetGate(memoryBudgetGate(Number.MAX_SAFE_INTEGER));
  const pg: Pg = await startPg();
  // Setup: a person's daily AI allowance (career_spend_cap.ts) is raised so one turn can draft 150 emails; step J checks the
  // allowance itself, with the day nearly used.
  const env: Record<string, string> = { CAREER_NETWORKING_DRAFT: "on", ANTHROPIC_API_KEY: "test-placeholder-not-a-key", CAREER_MODEL: "claude-haiku-5-5", CAREER_MODEL_DAILY_CALLS: "1000", CAREER_MODEL_DAILY_USD: "5" };
  const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "CAREER_SEND_RAIL", "CAREER_OUTREACH_SEND", "CAREER_PEOPLE_SEARCH"];
  const saved = Object.fromEntries([...Object.keys(env), ...unset].map((k) => [k, Deno.env.get(k)]));
  for (const k of unset) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const outbound: string[] = [];
  const realError = console.error;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(TOKENS)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_outreach_prefs (user_id, signature) values ('${id}', 'Sam Testcase');`);
    }
    const q = async (s: string) => (await pg.sql(s)).trim();
    const json = async (s: string) => JSON.parse((await q(s)) || "null");
    h = await careerHandler(pg, TOKENS);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
      if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.origin}${u.pathname}`); throw new TypeError(`network refused: ${u.host}`); }
      return await viaDouble(req);
    }) as typeof fetch;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
    const fails: string[] = [];
    const approvedHere = new Set<string>();
    const fail = (x: string) => { fails.push(x); };
    let next = 0;
    // One person, their own account, a chat whose career state holds their confirmed facts.
    const person = async () => {
      const i = next++;
      if (i >= N_USERS) throw new Error("more people than tokens");
      const id = uid(i);
      const tid = (await q(`with t as (insert into public.agent_threads (user_id, title) values ('${id}', 'TEST r3') returning id)
        insert into public.agent_flow_state (thread_id, user_id, state, updated_at) select id, '${id}', '${sq(JSON.stringify({ career: { stores: { profile: { facts: FACTS } } } }))}'::jsonb, now() from t returning thread_id`)).split("\n")[0].trim();
      const chat = h!.chat(`tok-r3-${i}`);
      let first = true;
      const say = async (m: string, extra: Record<string, unknown> = {}): Promise<Turn> => {
        await pg.sql(`delete from public.agent_rate_limits`);
        const r = await chat.say(m, first ? { thread_id: tid, ...extra } : extra);
        first = false;
        eq(r.status, 200, `${m}: ${r.reply}`);
        return r;
      };
      const drafts = async () => await json(`select coalesce(jsonb_agg(jsonb_build_object('n', n, 'to', recipient_email, 'status', status, 'body', body, 'subject', subject, 'recipient', recipient) order by created_at, n), '[]') from career_outreach_drafts where user_id = '${id}'`);
      const intros = async () => await json(`select coalesce(jsonb_agg(jsonb_build_object('to', to_email, 'route', route, 'body', body)), '[]') from career_intro_requests where user_id = '${id}'`);
      const csv = (rows: { name: string; firm: string; title?: string; school?: string; email?: string | null }[]) =>
        ["Name,Company,Title,School,Email", ...rows.map((r) => [r.name, r.firm, r.title ?? "", r.school ?? "", r.email ?? ""].map((x) => (/[,"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(","))].join("\n");
      const importList = async (rows: Parameters<typeof csv>[0], file = "Connections.csv") => {
        const r = await say("here are my contacts", { attachments: [{ name: file, mime: "text/csv", text: csv(rows) }] });
        if (r.intent !== "career_contacts_import") fail(`import ${file}: ${r.intent} ${r.reply.slice(0, 200)}`);
        return r;
      };
      return { id, i, say, drafts, intros, importList, chat: chat as Chat };
    };
    const ALL = generate();
    const pickEvery = <T>(xs: T[], n: number) => xs.filter((_, k) => k % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);

    // ---------------------------------------------------------------------------------------------- A
    await t.step("A. names, accents, honorifics and two people with one name: the one asked for, or which; never merged", async () => {
      let n = 0;
      for (const s of pickEvery(ALL.names, 10)) {
        const p = await person();
        await p.importList(s.contacts.map((c) => ({ name: c.name, firm: c.firm, title: c.title, email: c.email })));
        const r = await p.say(s.ask);
        const ds = await p.drafts();
        if (s.expectWhich) { if (ds.length || r.resultStatus !== "which") fail(`[A names] ${s.ask}: expected which, got ${r.resultStatus} with ${ds.length} drafts: ${r.reply.slice(0, 160)}`); }
        else if (s.expectTo === null) { if (ds.length) fail(`[A names] ${s.ask}: drafted to ${ds[0].to}`); }
        else if (ds.length !== 1 || ds[0].to !== s.expectTo) fail(`[A names] ${s.ask}: expected one draft to ${s.expectTo}, got ${JSON.stringify(ds.map((d: any) => d.to))} (${r.intent}/${r.resultStatus}: ${r.reply.slice(0, 160)})`);
        n++;
      }
      for (const s of pickEvery(ALL.same_name.filter((x) => x.adv?.when !== "always"), 14)) {
        const p = await person();
        if (s.adv) ADV.set(s.name, s.adv as any); else ADV.delete(s.name);
        await p.importList([s.a, s.b].map((c) => ({ name: c.name, firm: c.firm, title: c.title, school: c.school, email: c.email })));
        const r = await p.say(s.ask);
        const ds = await p.drafts();
        if (s.expect === "which") { if (ds.length || r.resultStatus !== "which") fail(`[A same name] ${s.ask}: expected which, got ${r.resultStatus} with ${ds.length} drafts`); }
        else {
          if (ds.length !== 1 || ds[0].to !== s.a.email) fail(`[A same name] ${s.ask}: expected one draft to ${s.a.email}, got ${JSON.stringify(ds.map((d: any) => d.to))} (${r.resultStatus}: ${r.reply.slice(0, 160)})`);
          for (const d of ds) {
            if (d.recipient.title !== s.a.title || d.recipient.school !== s.a.school) fail(`[A same name] ${s.ask}: the stored row is not A's own: ${JSON.stringify(d.recipient)}`);
            const text = `${d.subject}\n${d.body}`.toLowerCase();
            if ([s.b.title, s.b.school].some((x) => x && text.includes(x.toLowerCase()))) fail(`[A same name] ${s.ask}: the draft carries the other person's facts: ${d.body}`);
          }
        }
        ADV.delete(s.name);
        n++;
      }
      console.log(`[people-drafts-r3 e2e] A: ${n} flows`);
    });

    // ---------------------------------------------------------------------------------------------- B
    await t.step("B. a title that changed: two lists read months apart, a page read this week: the newest title, or none", async () => {
      const cases = [
        { name: "Maya Chen", firm: "Ramp", old: "Data Analyst", fresh: "Data Science Manager", how: "list" },
        { name: "José Álvarez", firm: "Plaid", old: "Software Engineer", fresh: "Staff Engineer", how: "list" },
        { name: "Grace Okafor", firm: "Brex", old: "Risk Analyst", fresh: "Director of Risk", how: "page" },
        { name: "Omar Haddad", firm: "Figma", old: "Product Manager", fresh: "Head of Design", how: "page" },
        { name: "Lena Fischer", firm: "Stripe", old: "Data Analyst", fresh: "Analytics Lead", how: "same_day" },
      ];
      for (const c of cases) {
        const p = await person();
        const email = `${c.name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]+/g, ".")}@${c.firm.toLowerCase()}.example`;
        // the writer's first try says the old title; only the retry without it may be stored
        ADV.set(c.name, { when: "first", add: () => `I know you're a ${c.old} at ${c.firm}.` });
        await p.importList([{ name: c.name, firm: c.firm, title: c.old, email }], "Connections-2025.csv");
        await pg.sql(`update public.career_account_contacts set updated_at = now() - interval '300 days' where user_id = '${p.id}'`);
        if (c.how === "page") {
          await pg.sql(`insert into public.career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, retrieved_at)
            values ('${p.id}', 'company_page', '${sq(c.name)}', '${email}', '${c.firm}', '${c.firm.toLowerCase()}', '${sq(c.fresh)}', 'https://${c.firm.toLowerCase()}.example/team (schema.org Person)', 'https://${c.firm.toLowerCase()}.example/team', 'e:${email}', now() - interval '2 days')`);
        } else {
          await p.importList([{ name: c.name, firm: c.firm, title: c.fresh, email }], "Connections-2026.csv");
          if (c.how === "same_day") await pg.sql(`update public.career_account_contacts set updated_at = '2026-10-01T00:00:00Z' where user_id = '${p.id}'`);
        }
        const r = await p.say(`email ${c.name} at ${c.firm}`);
        const ds = await p.drafts();
        const want = c.how === "same_day" ? "" : c.fresh;
        ADV.delete(c.name);
        if (ds.length !== 1) { fail(`[B] ${c.name}: expected one draft (the stale-title try refused, the clean retry kept), got ${ds.length}: ${r.reply.slice(0, 200)}`); continue; }
        if (ds[0].recipient.title !== want) fail(`[B] ${c.name}: the draft's row title is ${JSON.stringify(ds[0].recipient.title)}, expected ${JSON.stringify(want)}`);
        if (ds[0].body.includes(c.old)) fail(`[B] ${c.name}: the draft says the old title: ${ds[0].body}`);
      }
      console.log(`[people-drafts-r3 e2e] B: ${cases.length} flows`);
    });

    // ---------------------------------------------------------------------------------------------- C
    await t.step("C. a stored row that speaks to the writer: never in the prompt, never in a draft", async () => {
      const inj = ALL.injection.filter((s) => !/[^\x00-\x7f]/.test(s.c.name));
      for (const s of pickEvery(inj, 10)) {
        const p = await person();
        const data = { file: "Connections.csv", row: 1, name: s.c.name, email: s.c.email, firm: s.c.firm, firm_raw: s.c.firm, company: s.c.firm, title: s.c.title, school: s.c.school, connected_on: null, verified: true,
          check: { syntax: "pass", mx: "not_run", role: "pass", disposable: "pass", ran: ["syntax", "role", "disposable"] } };
        await pg.sql(`insert into public.career_account_contacts (user_id, row_key, person_key, file, name_key, email, firm_key, firm_raw_key, data)
          values ('${p.id}', 'Connections.csv#1', 'e:${s.c.email}', 'Connections.csv', '${sq(s.c.name.toLowerCase())}', '${s.c.email}', '${s.c.firm.toLowerCase()}', '${s.c.firm.toLowerCase()}', '${sq(JSON.stringify(data))}'::jsonb)`);
        const before = prompts.length;
        const r = await p.say(`email ${s.c.name} at ${s.c.firm}`);
        const mine = prompts.slice(before);
        const injected = (s.field === "title" ? s.c.title! : s.c.school!).split(/[.|(\n-]\s*/).filter((x) => x.length > 12).pop() ?? "";
        if (mine.some((u) => injected && u.includes(injected.trim()))) fail(`[C] ${s.category}: the injected text reached the writer: ${injected}`);
        const ds = await p.drafts();
        if (!ds.length) fail(`[C] ${s.category}: nothing drafted once the injected text was dropped: ${r.reply.slice(0, 200)}`);
        for (const d of ds) if (`${d.recipient.title} ${d.recipient.school}`.includes(injected.trim())) fail(`[C] ${s.category}: the stored row keeps the injected text: ${JSON.stringify(d.recipient)}`);
      }
      console.log(`[people-drafts-r3 e2e] C: 10 flows`);
    });

    // ---------------------------------------------------------------------------------------------- D
    await t.step("D. opted out with someone else, or bounced: in a fresh search, a list or an intro, never drafted to", async () => {
      const other = uid(N_USERS - 1);
      for (let k = 0; k < 8; k++) {
        const p = await person();
        const firm = ["Ramp", "Stripe", "Plaid", "Brex"][k % 4], d = `${firm.toLowerCase()}.example`;
        const people = [["Ava Grant", "ava.grant"], ["Liam Hale", "liam.hale"], ["Mia Moss", "mia.moss"], ["Eli Reid", "eli.reid"]];
        // two found by discovery (provider, sendable), two on their own list
        for (const [name, local] of people.slice(0, 2)) await pg.sql(`insert into public.career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, provider, provider_id, fetched_at, email_status, mx, sendable, domain)
          values ('${p.id}', 'provider', '${name}', '${local}@${d}', '${firm}', '${firm.toLowerCase()}', 'Data Analyst', 'https://${d}/team', 'https://${d}/team', 'e:${local}@${d}', 'web', '${local}', now(), 'published', 'pass', true, '${d}')`);
        await p.importList(people.slice(2).map(([name, local]) => ({ name, firm, title: "Data Analyst", email: `${local}@${d}` })));
        // one of each kind blocked: a stop to ANOTHER person, a bounce for anyone
        const stopped = `${people[k % 2][1]}@${d}`, bounced = `${people[2 + (k % 2)][1]}@${d}`;
        await pg.sql(`insert into public.career_outreach_dnc (user_id, email_hash) values ('${other}', '${await sha(stopped)}') on conflict do nothing;
          insert into public.career_send_bad_addresses (email_hash) values ('${await sha(bounced)}') on conflict do nothing;`);
        const ask = k % 2 ? `reach out to people at ${firm}` : `get me an intro to ${people[k % 2][0]} at ${firm}`;
        const r = await p.say(ask);
        const ds = await p.drafts(), is = await p.intros();
        for (const x of ds) if ([stopped, bounced].includes(x.to)) fail(`[D] ${ask}: drafted to ${x.to}`);
        for (const x of is) if ([stopped, bounced].includes(String(x.to))) fail(`[D] ${ask}: an intro to ${x.to}`);
        if (k % 2 && ds.length !== 2) fail(`[D] ${ask}: expected the two people who may be written to, got ${JSON.stringify(ds.map((x: any) => x.to))}: ${r.reply.slice(0, 200)}`);
      }
      console.log(`[people-drafts-r3 e2e] D: 8 flows`);
    });

    // ---------------------------------------------------------------------------------------------- E
    await t.step("E. referral asks: another firm's job, or a posting closed on the board: not drafted; an open one is", async () => {
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, url, first_seen_at, last_seen_at, closed_at) values
        ('greenhouse:ramp:r3-1', 'greenhouse', 'ramp', 'Ramp', 'Data Analyst', 'https://boards.greenhouse.io/ramp/jobs/1', now() - interval '40 days', now() - interval '5 days', now() - interval '5 days'),
        ('greenhouse:stripe:r3-2', 'greenhouse', 'stripe', 'Stripe', 'Risk Analyst', 'https://boards.greenhouse.io/stripe/jobs/2', now() - interval '10 days', now(), null)`);
      const cases = [
        { firm: "Ramp", topic: "a referral for the Data Analyst role", expect: "refuse", why: /closed/ },
        { firm: "Ramp", topic: "a referral for the Risk Analyst role at Stripe", expect: "refuse", why: /at Stripe has to come from someone at Stripe/ },
        { firm: "Stripe", topic: "a referral for the Risk Analyst role", expect: "draft", why: null },
        { firm: "Stripe", topic: "a referral for the Product Manager role", expect: "draft", why: null },
        { firm: "Plaid", topic: "a referral for the Data Analyst role at Ramp", expect: "refuse", why: /at Ramp has to come from someone at Ramp/ },
      ];
      for (const c of cases) {
        const p = await person();
        ADV.set("Tara Nolan", { when: "always", add: (row) => (row.topic ? `Could you refer me for ${row.topic.replace(/^an? referral for /i, "")}?` : "") });
        await p.importList([{ name: "Tara Nolan", firm: c.firm, title: "Data Scientist", email: `tara.nolan@${c.firm.toLowerCase()}.example` }]);
        const r = await p.say(`email Tara Nolan at ${c.firm} about ${c.topic}`);
        const ds = await p.drafts();
        if (c.expect === "refuse" && (ds.length || !c.why!.test(r.reply))) fail(`[E] ${c.topic} to ${c.firm}: expected refused (${c.why}), got ${ds.length} drafts: ${r.reply.slice(0, 220)}`);
        if (c.expect === "draft" && ds.length !== 1) fail(`[E] ${c.topic} to ${c.firm}: expected a draft, got ${r.resultStatus}: ${r.reply.slice(0, 220)}`);
        ADV.delete("Tara Nolan");
      }
      console.log(`[people-drafts-r3 e2e] E: ${cases.length} flows`);
    });

    // ---------------------------------------------------------------------------------------------- F
    await t.step("F. alumni by a short school name: whole words only, two schools said", async () => {
      const p = await person();
      const rows = [["Ava Grant", "UT Austin"], ["Liam Hale", "UT Knoxville"], ["Mia Moss", "Rutgers University"], ["Eli Reid", "Dartmouth College"], ["Zoe Shaw", "University of Utah"], ["Kai Vance", "Butler University"]];
      for (const [k, [name, school]] of rows.entries()) await pg.sql(`insert into public.career_people (user_id, source, name, company, company_key, position, school, source_ref, dedupe_key)
        values ('${p.id}', 'linkedin_export', '${name}', 'Ramp', 'ramp', 'Analyst', '${school}', 'Connections.csv, row ${k + 1}', 'n:${name.toLowerCase()}|ramp')`);
      const r = await p.say("UT alumni at Ramp");
      const listed = rows.filter(([name]) => r.reply.includes(`- ${name},`)).map(([name]) => name);
      eq(listed.sort(), ["Ava Grant", "Liam Hale"], `only the two UT schools: ${r.reply}`);
      assert(/more than one school/.test(r.reply), `two schools under one short name are said: ${r.reply}`);
      console.log(`[people-drafts-r3 e2e] F: 1 flow`);
    });

    // ---------------------------------------------------------------------------------------------- G
    await t.step("G. a writer that praises work never done, gives a title the row lacks, or claims something in common: nothing of it stored", async () => {
      const cases = [
        { name: "Noah Patel", title: "", add: () => "I loved your recent talk on fraud models." },
        { name: "Priya Shah", title: "", add: () => "As a senior engineer, you must see a lot." },
        { name: "Alex Kim", title: "Product Manager", add: () => "As a data analyst, you must see a lot." },
        { name: "Sam Rivera", title: "Data Scientist", add: (row: Record<string, string>) => `I was also at ${row.firm} last summer.` },
        { name: "Ben Ortiz", title: "Data Scientist", add: () => "We both studied at Rice University." },
        { name: "Ivan Petrov", title: "Engineering Manager", add: () => "I saw your work on the new checkout." },
      ];
      for (const c of cases) {
        const p = await person();
        ADV.set(c.name, { when: "first", add: c.add });
        await p.importList([{ name: c.name, firm: "Notion", title: c.title, school: "Rice University", email: `${c.name.toLowerCase().replace(/ /g, ".")}@notion.example` }]);
        const r = await p.say(`email ${c.name} at Notion`);
        const ds = await p.drafts();
        if (ds.length !== 1) fail(`[G] ${c.name}: the clean retry was not stored: ${r.reply.slice(0, 200)}`);
        const bad = c.add({ firm: "Notion" } as any).replace(/[.]$/, "");
        for (const d of ds) if (d.body.includes(bad)) fail(`[G] ${c.name}: stored with "${bad}"`);
        ADV.delete(c.name);
      }
      console.log(`[people-drafts-r3 e2e] G: ${cases.length} flows`);
    });

    // ---------------------------------------------------------------------------------------------- H
    await t.step("H. a discovered person whose stored address is a guessed personal mailbox: never drafted to", async () => {
      for (const [k, dom] of ["gmail.com", "outlook.com", "icloud.com"].entries()) {
        const p = await person();
        const firm = "Mercury", d = "mercury.example";
        const rows = [["Ruth Lane", `ruth.lane${k}@${dom}`, "inferred"], ["Kofi Mensah", `kofi.mensah@${d}`, "inferred"], ["Dana Cole", `dana.cole@${d}`, "published"]];
        for (const [name, email, status] of rows) await pg.sql(`insert into public.career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, provider, provider_id, fetched_at, email_status, mx, sendable, domain)
          values ('${p.id}', 'provider', '${name}', '${email}', '${firm}', 'mercury', 'Data Analyst', 'https://${d}/team', 'https://${d}/team', 'e:${email}', 'web', '${sq(name)}', now(), '${status}', 'pass', true, '${email.split("@")[1]}')`);
        const r = await p.say(`reach out to people at ${firm}`);
        const ds = await p.drafts();
        const to = ds.map((x: any) => x.to).sort();
        eq(to, [`dana.cole@${d}`, `kofi.mensah@${d}`], `only work addresses: ${r.reply.slice(0, 300)}`);
        for (const x of ds) if (x.to === `kofi.mensah@${d}` && x.recipient.address !== "inferred") fail(`[H] the inferred work address is not labeled inferred`);
      }
      console.log(`[people-drafts-r3 e2e] H: 3 flows`);
    });

    // ---------------------------------------------------------------------------------------------- I
    await t.step("I. 150 people at one firm: 150 drafts, each once, numbered 1..150, no cap", async () => {
      const p = await person();
      const rows = Array.from({ length: 150 }, (_, j) => ({ name: `Person ${String.fromCharCode(65 + (j % 26))}${String.fromCharCode(65 + Math.floor(j / 26))} Batchrow`, firm: "Datadog", title: "Data Analyst", email: `batch.${j}@datadog.example` }));
      await p.importList([...rows, { name: "Other Noise", firm: "Figma", title: "Designer", email: "other.noise@figma.example" }]);
      // (since #418 "draft emails to people at X" is planned as a list first; "reach out to everyone at X" drafts from their own list)
      const r = await p.say("reach out to everyone at Datadog");
      eq([r.intent, r.resultStatus], ["career_outreach_batch", "drafted"], r.reply.slice(0, 300));
      const ds = await p.drafts();
      eq(ds.length, 150, `every one drafted: ${r.reply.slice(0, 200)} ... ${r.reply.slice(-600)}`);
      eq(ds.map((d: any) => d.n).sort((a: number, b: number) => a - b), Array.from({ length: 150 }, (_, j) => j + 1), "numbered 1..150 once each");
      assert(ds.every((d: any) => d.to.endsWith("@datadog.example") && d.status === "shown"), "only Datadog, nothing approved");
      eq(await q(`select count(*) from public.career_send_queue`), "0", "nothing on the send rail");
      // a draft past 99 is approved by its own number: exactly that one, bound to its own hash
      const yes = await p.say("send 120");
      eq(yes.resultStatus, "approved", yes.reply.slice(0, 300));
      const after = await json(`select coalesce(jsonb_agg(jsonb_build_object('n', n, 'ok', approved_hash = hash)), '[]') from career_outreach_drafts where user_id = '${p.id}' and status = 'approved'`);
      eq(after, [{ n: 120, ok: true }], "exactly draft 120, approved against its own hash");
      approvedHere.add(p.id);
      console.log(`[people-drafts-r3 e2e] I: 150 drafts, draft 120 approved`);
    });

    // ---------------------------------------------------------------------------------------------- J
    await t.step("J. (D-046) no per-person AI allowance: a person who already made 998 calls today still gets every draft", async () => {
      const p = await person();
      await p.importList(Array.from({ length: 5 }, (_, j) => ({ name: `Quota ${String.fromCharCode(65 + j)} Person`, firm: "Sony", title: "Data Analyst", email: `quota.${j}@sony.example` })));
      // setup: 998 of the day's 1,000 calls already used (a recorded turn earlier today)
      await pg.sql(`insert into public.agent_turn_costs (user_id, meter_state, provider, models, calls, usd_micros) values ('${p.id}', 'metered', 'openai', '{claude-haiku-5-5}', 998, 0)`);
      const r = await p.say("reach out to everyone at Sony");
      const ds = await p.drafts();
      eq(ds.length, 5, `every draft is written, whatever was used today: ${r.reply.slice(0, 300)}`);
      assert(!/today's limit on AI-written drafts/.test(r.reply) && !/Not drafted yet/.test(r.reply), `no per-person limit is said: ${r.reply.slice(0, 400)}`);
      assert(!/the writing model didn't answer/.test(r.reply), `not as a model failure: ${r.reply.slice(0, 400)}`);
    });

    await t.step("nothing left the machine, nothing was approved or sent; every problem found is listed", async () => {
      eq(outbound, [], "no request but the Supabase double and the scripted Anthropic URL");
      eq(await q(`select count(*) from public.career_outreach_drafts where status <> 'shown' and not (user_id = any('{${[...approvedHere].join(",")}}'::uuid[]) and status = 'approved')`), "0", "nothing approved but the one asked for, nothing sent or dropped behind the person's back");
      if (fails.length) throw new Error(`${fails.length} scenario failures:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
      const unexpected = errors.filter((e) => !/not connected|NOT_WIRED|no Gmail|gmail/i.test(e));
      if (unexpected.length) console.log(`[people-drafts-r3 e2e] logged errors (${unexpected.length}): ${unexpected.slice(0, 5).join(" | ")}`);
      console.log(`[people-drafts-r3 e2e] ${next} people, ${prompts.length} writer calls`);
    });
  } finally {
    console.error = realError;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    await pg.stop();
    resetLocalBudgetGate();
  }
} });
