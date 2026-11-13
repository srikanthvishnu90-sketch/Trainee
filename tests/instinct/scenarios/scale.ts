// Instinct, SCALE (owner, 2026-10-27: 100,000 people at once, hundreds of applications and emails each; NO LIMITS): the
// same two features for many synthetic people at once on one real Postgres, through the deployed agent-chat function, with
// exactly-once and fairness asserted and the numbers measured.
//   apply     U people (plus one heavy person with 10x the items) each with K applications their computer prepared
//             (career_apply_prepare_own, as the computer stores them; the chat path that gets there is measured in the
//             mass-apply scenario), all at once: "show my applications" then "yes"; then every person's computer
//             online at once, TWO computers per person racing for the same queue (a laptop and a desktop), each driving
//             with an engine stand-in that POSTs the approved payload to a counting employer (Chromium per item would
//             measure the browser, not the queue).
//   outreach  U people each with M approved emails and their own connected Gmail (the real OAuth function); the deployed
//             career-proactive function called by W instances at once, round after round, as a horizontally scaled
//             scheduler would; every email must go exactly once, from its own account, and every person must get sends
//             in the first rounds (one heavy sender can't starve the rest).
// deno-lint-ignore-file no-explicit-any
import { check, type Scorecard } from "../judge.ts";
import { Person, persona } from "../people.ts";
import type { EngineResult } from "../../../workers/career-browser/approve-first.ts";
import { messageOf, payloadHash, supabaseOutreachStore } from "../../../supabase/functions/_shared/career_outreach.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { advanceClock, type Workers } from "../ticks.ts";
import { SERVICE_KEY, SUPABASE_URL, type World } from "../world.ts";
import { guarded, st } from "./common.ts";

interface Cfg { scaleUsers: number; scaleItems: number; scaleConcurrency: number; groups: Set<string> }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k], k); } }));
  return out;
}
const RESUME_FILE = new TextEncoder().encode("%PDF-1.4\n% TEST instinct scale resume\n%%EOF\n");

export async function scaleScenarios(w: World, ws: Workers, card: Scorecard, cfg: Cfg) {
  const on = (g: string) => !cfg.groups.size || cfg.groups.has(g) || cfg.groups.has("scale");
  if (on("apply-scale")) { console.log(`\n== SCALE apply: ${cfg.scaleUsers} people x ${cfg.scaleItems}`); await guarded(card, "scale", "apply", "web", () => applyScale(w, ws, card, cfg)); }
  if (on("outreach-scale")) { console.log(`\n== SCALE outreach: ${cfg.scaleUsers} people`); await guarded(card, "scale", "outreach", "web", () => outreachScale(w, card, cfg)); }
}

async function applyScale(w: World, ws: Workers, card: Scorecard, cfg: Cfg) {
  const run = card.scenario("scale", `apply: ${cfg.scaleUsers} people x ${cfg.scaleItems} (+1 x ${cfg.scaleItems * 10}), at once`, "web");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME_FILE))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // A counting employer: one POST per approved application, keyed by the approved URL.
  const hits = new Map<string, number>();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
    await req.text();
    return new Response(`<h1>Thank you for applying</h1><p>Confirmation number: SCALE-${hits.size}.</p>`, { headers: { "content-type": "text/html" } });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  // The engine stand-in: POST the approved application to its URL once, report what the page said.
  const engine = async (args: string[]): Promise<EngineResult | null> => {
    const url = args[args.indexOf("--url") + 1];
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return null;
    const r = await fetch(url, { method: "POST", body: "approved" });
    const text = await r.text();
    return { result: { state: r.ok ? "submitted_unconfirmed" : "failed", confirmation_id: /SCALE-\d+/.exec(text)?.[0] ?? null }, evidence: {} };
  };
  const people: Person[] = [];
  try {
    const total = cfg.scaleUsers + 1;
    await run.step(`setup: ${total} people sign up; each computer stores its prepared applications`, async () => {
      const t0 = performance.now();
      await pool(Array.from({ length: total }, (_, i) => i), cfg.scaleConcurrency, async (i) => {
        const p = new Person(w, "web", 9000 + i, persona(9000 + i, "Scale", `Person${i}`));
        await p.begin();
        people[i] = p;
        const u = p.userId!;
        await w.pg.sql(`insert into public.profiles (id) values ('${u}') on conflict do nothing;
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}') on conflict do nothing;
          with t as (insert into public.agent_threads (user_id, title) values ('${u}', 'TEST seeded resume') returning id)
          insert into public.agent_flow_state (thread_id, user_id, state, updated_at) select id, '${u}', '{"career":{"stores":{"profile":{"facts":[{"id":"seed","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-${i}","text":"TEST Analyst, TEST Co"}]}}}}', now() - interval '30 days' from t;
          insert into public.career_events (user_id, kind, subject, detail) values ('${u}', 'fact_confirmed', 'TEST Analyst, TEST Co', jsonb_build_object('confirmation_event_id','seed-${i}','upload',jsonb_build_object('kind','file','ref','TEST scale resume','sha256','${sha}')));`);
        ws.memory.files.set(`career-resumes/${u}/${sha}.pdf`, RESUME_FILE);
        const k = i === 0 ? cfg.scaleItems * 10 : cfg.scaleItems;
        const client = w.pg.asPerson(u);
        for (let j = 1; j <= k; j++) {
          const url = `${base}/scale/${u.slice(0, 8)}/${j}`;
          const payload = { version: 1, user_id: u, job_id: url, company: `Scale Employer ${i}-${j}`, url, fields: [{ name: "email", label: "Email", value: p.p.email, factId: "TEST-1" }],
            privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(), resume_sha256: sha };
          const r = await client.rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`Scale Employer ${i}-${j}: TEST Analyst`, `Email: ${p.p.email}`, `Sends to ${url}`] });
          if (r.error) throw new Error(`prepare_own for person ${i} item ${j}: ${r.error.message}`);
        }
      });
      const n = Number(await w.one(`select count(*) from public.career_apply_prepared where state = 'ready' and user_id in (${people.map((p) => `'${p.userId}'`).join(",")})`));
      check(n === cfg.scaleUsers * cfg.scaleItems + cfg.scaleItems * 10, `${n} prepared`);
      return `${total} people, ${n} prepared applications, in ${Math.round(performance.now() - t0)} ms`;
    });
    const lat: number[] = [];
    let heavyMs = 0;
    await run.step(`everyone at once: "show my applications" then one "yes"; every person's whole batch approved, by its hashes`, async () => {
      const t0 = performance.now();
      const outs = await pool(people, cfg.scaleConcurrency, async (p, i) => {
        const a = performance.now();
        await p.say("show my applications");
        await p.say("yes");
        // Each remaining card, as the replies say (reply to the card), so the measurement covers every application.
        for (let r = 0; r < 60; r++) {
          const open = (await st(w).cards(p.userId!)).filter((x: any) => x.state === "open");
          if (!open.length) {
            const left = Number(await w.one(`select count(*) from public.career_apply_prepared where user_id = '${p.userId}' and state in ('ready','shown')`));
            if (!left) break;
            await p.say("show my applications");
            if (!(await st(w).cards(p.userId!)).some((x: any) => x.state === "open")) break;
            continue;
          }
          await p.say("yes", { replyTo: await p.cardReplyId(open[0].id) });
        }
        const ms = performance.now() - a;
        if (i === 0) heavyMs = ms; else lat.push(ms);
        return p.turns.length;
      });
      const turns = outs.reduce((a, b) => a + b, 0);
      const jobs = Number(await w.one(`select count(*) from public.career_apply_jobs where user_id in (${people.map((p) => `'${p.userId}'`).join(",")})`));
      const bound = await w.one(`select coalesce(bool_and(approval_hash = payload_hash), true) from public.career_apply_jobs`);
      const want = cfg.scaleUsers * cfg.scaleItems + cfg.scaleItems * 10;
      const yeses = people.map((p) => p.turns.filter((t) => t.said === "yes").length);
      const wall = Math.round(performance.now() - t0);
      run.note(`apply scale: ${turns} turns in ${wall} ms; per person to approve everything: p50 ${Math.round(pct(lat, 0.5))} ms, p95 ${Math.round(pct(lat, 0.95))} ms; the heavy person ${Math.round(heavyMs)} ms; yeses per person: light ${pct(yeses.slice(1), 0.5)}, heavy ${yeses[0]}`);
      check(bound === "t", "a job approved under a hash that is not its payload's");
      check(jobs === want, `${jobs} of ${want} approved`);
      check(yeses.every((y) => y === 1), `people needed ${Math.max(...yeses)} yeses (the heavy person ${yeses[0]}): one yes should approve the whole batch`, "one yes approves the whole batch at any size (D-MS-1/2)");
      return `${jobs} approved with one yes each; ${turns} turns, p95 ${Math.round(pct(lat, 0.95))} ms per person`;
    });
    await run.step("every person's two computers race for the same queue: each application POSTed exactly once; none starves", async () => {
      const t0 = performance.now();
      const done: number[] = new Array(people.length).fill(0);
      await pool(people.flatMap((p, i) => [[p, i], [p, i]] as [Person, number][]), cfg.scaleConcurrency * 2, async ([p, i]) => {
        await ws.drive(p.userId!, { engine: engine as any });
        done[i] = performance.now() - t0;
      });
      const wall = performance.now() - t0;
      const twice = [...hits].filter(([, k]) => k > 1);
      const jobs = await w.rows(`select state, count(*)::int n from public.career_apply_jobs where user_id in (${people.map((p) => `'${p.userId}'`).join(",")}) group by state`);
      const sent = [...hits.values()].reduce((a, b) => a + b, 0);
      const want = cfg.scaleUsers * cfg.scaleItems + cfg.scaleItems * 10;
      const light = done.slice(1);
      run.note(`drive scale: ${sent} POSTs in ${Math.round(wall)} ms (${Math.round(sent / (wall / 1000))}/s); light people done p50 ${Math.round(pct(light, 0.5))} ms, max ${Math.round(Math.max(...light))} ms; heavy done ${Math.round(done[0])} ms; states ${JSON.stringify(jobs)}`);
      check(!twice.length, `${twice.length} applications POSTed twice (e.g. ${twice[0]?.[0]} x${twice[0]?.[1]})`);
      check(sent === want, `${sent} of ${want} POSTed`);
      return `${sent} POSTs, each once, ${Math.round(sent / (wall / 1000))}/s; states ${JSON.stringify(jobs)}`;
    });
  } finally {
    await server.shutdown();
  }
}

async function outreachScale(w: World, card: Scorecard, cfg: Cfg) {
  const M = Math.max(10, Math.min(cfg.scaleItems, 30));
  const U = cfg.scaleUsers;
  const run = card.scenario("scale", `outreach: ${U} people x ${M} approved emails (+1 x ${M * 5}), ${cfg.scaleConcurrency} scheduler instances at once`, "web");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const store = supabaseOutreachStore(admin);
  const people: Person[] = [];
  const accounts: string[] = [];
  let want = 0;
  await run.step(`setup: ${U + 1} people connect their own Gmail (the real OAuth function) and approve their emails`, async () => {
    const t0 = performance.now();
    await pool(Array.from({ length: U + 1 }, (_, i) => i), cfg.scaleConcurrency, async (i) => {
      const p = new Person(w, "web", 20000 + i, persona(20000 + i, "Out", `Reach${i}`));
      await p.begin();
      people[i] = p;
      const account = `outreach.${i}@gmail.example`;
      accounts[i] = account;
      await w.pg.sql(`insert into public.profiles (id) values ('${p.userId}') on conflict do nothing; insert into public.career_watch_kv (user_id, key, value) values ('${p.userId}', 'career:account', '{"epoch":0,"version":0,"paused":false}') on conflict do nothing;`);
      const start = await w.call("gmail-oauth", { method: "POST", headers: { Authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "start_career" }) });
      if (typeof start.body?.url !== "string") throw new Error(`start_career: ${JSON.stringify(start.body).slice(0, 120)}`);
      const back = new URL(w.fakes.google.consent(start.body.url, account));
      await w.call("gmail-oauth", { method: "GET", path: back.search });
      const k = i === 0 ? M * 5 : M;
      for (let b = 0; b < Math.ceil(k / 10); b++) {
        const ds = [];
        for (let n = 1; n <= Math.min(10, k - b * 10); n++) {
          const r = { name: `Recipient ${i}-${b}-${n}`, firm: `TEST Firm ${n}`, title: "Software Engineer", school: "", email: `r${i}.${b}.${n}@firm${n}.example`, source: "provider" };
          const d: any = { n, recipient: r, subject: "A quick question", body: `Hi ${r.name},\n\nWould you be open to a short call about your team?`, footer: `Out Reach${i}\n\nIf you'd rather not hear from me, reply stop and I won't write again.`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date().toISOString() };
          d.hash = await payloadHash(messageOf(d));
          ds.push(d);
        }
        const saved = await store.saveBatch(p.userId!, null, ds as any, Date.now());
        for (const d of saved) await store.update(p.userId!, { ...d, status: "approved", approved_hash: d.hash, approved_at: new Date().toISOString() }, { status: "shown" });
      }
    });
    want = Number(await w.one(`select count(*) from public.career_outreach_drafts where status = 'approved' and user_id in (${people.map((p) => `'${p.userId}'`).join(",")})`));
    check(want === U * M + M * 5, `${want} approved`);
    return `${U + 1} people connected, ${want} approved emails, in ${Math.round(performance.now() - t0)} ms`;
  });
  await run.step(`${cfg.scaleConcurrency} scheduler instances at once, round after round: every email exactly once, from its own account; everyone gets sends early`, async () => {
    const mine = new Set(accounts);
    const sentNow = () => w.fakes.google.sent.filter((m) => mine.has(m.account));
    const rounds: number[] = [];
    let firstRoundPeople = 0;
    const t0 = performance.now();
    for (let r = 0; r < 12; r++) {
      advanceClock(5 * 60_000);
      await Promise.all(Array.from({ length: cfg.scaleConcurrency }, () => w.call("career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": "INSTINCT-proactive-secret-0123456789abcdefgh", "content-type": "application/json" }, body: "{}" })));
      rounds.push(sentNow().length);
      if (r === 0) firstRoundPeople = new Set(sentNow().map((m) => m.account)).size;
      if (sentNow().length >= want) break;
    }
    const wall = performance.now() - t0;
    const sent = sentNow();
    const byTo = new Map<string, number>();
    for (const m of sent) byTo.set(`${m.account}>${m.to}`, (byTo.get(`${m.account}>${m.to}`) ?? 0) + 1);
    const twice = [...byTo].filter(([, k]) => k > 1);
    const wrong = sent.filter((m) => !m.to.startsWith(`r${accounts.indexOf(m.account)}.`));
    run.note(`outreach scale: sent after each round ${JSON.stringify(rounds)}; ${sent.length} in ${Math.round(wall)} ms; people with a send in round 1: ${firstRoundPeople} of ${U + 1}`);
    check(!twice.length, `${twice.length} emails sent twice (${twice[0]?.[0]})`);
    check(!wrong.length, `${wrong.length} emails went from the wrong account`);
    check(firstRoundPeople === U + 1, `only ${firstRoundPeople} of ${U + 1} people got a send in the first round`);
    check(sent.length === want, `${sent.length} of ${want} sent after ${rounds.length} rounds (${JSON.stringify(rounds)})`, "send every approved email as fast as Gmail allows (no Trainee pacing or daily cap)");
    return `${sent.length} sent, each once, from its own account; ${Math.round(sent.length / (wall / 1000))}/s`;
  });
}
