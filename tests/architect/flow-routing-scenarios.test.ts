// ROUTING SCENARIOS through the REAL handler (architect, 2026-10-29): a stratified sample (344 of the 10,000 in
// tests/architect/routing-scenarios.ts, every family, strict and noisy, and every phrasing pinned as fixed) sent one per
// fresh thread to the production career handler (supabase/functions/agent-chat/handler-career.ts handleChat; harness
// tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts, real Postgres 16 with every migration).
// For each: the turn that answered (from the reply's intent) is the one the pure mirror (pureRoute) names and one the
// scenario allows; and nothing external happened: no request left the machine but a posting-board read (refused here),
// nothing on the send rail, no draft approved, no application approved or sent, no subscription changed, and only an
// apply ask ever adds to the person's apply queue. No model: CAREER_BRAIN, OPENAI_API_KEY and every model switch unset.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { COLLIDING, COMPANIES, pureRoute, type Route, rng, type Scenario, scenarios, SITE_NAMED, world } from "./routing-scenarios.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-00000000a7e1";

// The turn, read back from the reply's intent (handler-career.ts sets one per turn).
function routeOf(intent: string | null): Route {
  const i = String(intent ?? "");
  if (/^career_connectors?_|^career_connectors$|^career_gmail_connect|^career_google_disconnect/.test(i)) return "connectors";
  if (/^career_outlook_/.test(i)) return "outlook";
  if (i === "career_site_refused" || i === "career_linkedin_refused") return "site_refused";
  if (/^career_apply_card/.test(i)) return "cards";
  if (/^career_mock/.test(i)) return "mock";
  if (/^career_apply_questions/.test(i)) return "questions";
  if (/^career_apply_email/.test(i)) return "email";
  if (i === "career_outreach_batch" || i === "career_outreach_answer") return "outreach";
  if (i === "career_outreach_actions" || i === "career_outreach_summary" || i === "career_outreach_interval") return "outreach_replies";
  if (/^career_cloud|^career_resume_record/.test(i)) return "cloud";
  if (i === "career_apply_pace") return "apply_pace";
  if (/^career_billing/.test(i)) return "billing";
  if (i === "career_apply_cancel") return "apply_cancel";
  if (i === "career_apply_queue" || i === "career_apply_employer_ask") return "apply_queue";
  if (i === "career_apply_receipt") return "receipt";
  if (/^career_followup_/.test(i)) return "followup";
  if (i === "career_apply_status" || i === "career_inbox" || i === "career_followups_due") return "standing";
  if (/^career_contacts_|^career_networking_|^career_outreach_signature|^career_people_|^career_intro_|^career_job_emails$|^career_outreach_track$/.test(i)) return "networking";
  if (i === "career_outreach_send_status") return "outreach_status";
  return "router";
}
// The standing turn answers every application-status ask before the status turn (both say career_apply_status); the
// connector framework and the Outlook turn share their intents ("disconnect outlook" is either's).
const same = (r: Route): Route => (r === "status" ? "standing" : r === "outlook" ? "connectors" : r);

// 16 strict and 16 noisy per family (multi has strict only), seeded: 340+ with the pinned fixes. An even share of strict and noisy, seeded; plus the pinned fixes.
function sample(): Scenario[] {
  const all = scenarios();
  const r = rng(1029);
  const pick: Scenario[] = [];
  const families = [...new Set(all.map((s) => s.family))];
  for (const f of families) {
    for (const strict of [true, false]) {
      const pool = all.filter((s) => s.family === f && s.strict === strict);
      const n = Math.min(pool.length, 16);
      for (let k = 0; k < n; k++) pick.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    }
  }
  const pinned = ["withdraw from Stripe", "remove Stripe from my list", "hey don't apply to Stripe", "hey did you apply to Stripe", "email status",
    "any update on my emails", "what did I apply to", "status of my apps", "connect gmail and apply to Stripe", "withdraw from Stripe and apply to Ramp",
    "what's my bill", "remove LinkedIn from my list", "can you remove Figma from my list", "what's the status of my outreach emails"];
  for (const m of pinned) { const s = all.find((x) => x.message === m); if (s && !pick.includes(s)) pick.push(s); }
  return pick;
}

Deno.test({
  name: "Routing scenarios through the real handler: each sampled phrasing takes the turn the mirror names, and nothing external happens",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "OPENAI_API_KEY",
      "CAREER_NETWORKING_DRAFT", "CAREER_SEND_RAIL", "CAREER_PEOPLE_SEARCH", "STRIPE_SECRET_KEY", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    // D-036: CAREER_MAIL_TRACKING is a release flag (on when unset): every mail path stays off only with "off".
    Deno.env.set("CAREER_MAIL_TRACKING", "off");
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const realError = console.error;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'routing@example.test'); insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      // One open Data Analyst posting at every employer the scenarios name (a named apply ask is then the apply turn's).
      const all = [...COMPANIES, ...COLLIDING, ...SITE_NAMED];
      const desc = "TEST Analyst. Requirements: SQL, Python.";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${all.map((c, i) => `('greenhouse:routing${i}:${i + 1}', 'greenhouse', 'routing${i}', '${c}', 'Data Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/routing${i}/jobs/${i + 1}', '${desc}', now(), now())`).join(",")};`);
      h = await careerHandler(pg, { "tok-routing": PERSON });
      const viaDouble = globalThis.fetch;
      const outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as string | URL, init);
        const u = new URL(req.url);
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {}; // the turns' own logged refusals (a board read refused here) are not this test's subject
      const n = async (sql: string) => Number(await pg.sql(sql));
      const effects = async () => ({
        send: await n(`select count(*) from public.career_send_queue where user_id = '${PERSON}'`),
        approvedDrafts: await n(`select count(*) from public.career_outreach_drafts where user_id = '${PERSON}' and approved_hash is not null`),
        jobs: await n(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`),
        subs: await n(`select count(*) from public.user_subscriptions where user_id = '${PERSON}'`),
      });
      const wanted = async () => await n(`select count(*) from public.career_apply_wanted where user_id = '${PERSON}'`);
      const zero = await effects();

      const picks = sample();
      assert(picks.length >= 300, `a sample of 300+ (${picks.length})`);
      const started = Date.now();
      const wrong: string[] = [], mirror: string[] = [];
      const byFamily: Record<string, number> = {};
      for (const s of picks) {
        await pg.sql(`delete from public.agent_rate_limits where user_id = '${PERSON}'`);
        const before = await wanted();
        const t = await h.chat("tok-routing").say(s.message); // a fresh thread each: no state carried between scenarios
        eq(t.status, 200, `${s.message}: ${t.status} ${t.reply}`);
        const got = routeOf(t.intent), pure = pureRoute(s.message, world);
        byFamily[s.family] = (byFamily[s.family] ?? 0) + 1;
        if (!s.expect.map(same).includes(same(got)) && !(s.family === "site_named" || s.family === "site") ) wrong.push(`${s.family} ${JSON.stringify(s.message)}: expected ${s.expect.join("|")}, got ${got} (${t.intent})`);
        if (same(got) !== same(pure)) mirror.push(`${JSON.stringify(s.message)}: handler ${got} (${t.intent}), mirror ${pure}`);
        if (s.family === "site_named" || s.family === "site") assert([...s.expect.map(same), "site_refused", "router", "networking"].includes(same(got)), `${s.message}: ${got}`);
        if (got !== "apply_queue") eq(await wanted(), before, `only an apply ask adds to the apply queue: ${s.message} (${t.intent})`);
        if (s.family === "multi") assert(!["apply_queue", "apply_cancel", "billing"].includes(got), `two asks are never acted on: ${s.message} -> ${got}`);
      }
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(JSON.stringify({ sent: picks.length, seconds: secs, byFamily, outbound: [...new Set(outbound)] }));
      eq(wrong, [], "every sampled phrasing takes its turn");
      eq(mirror, [], "the pure mirror names the handler's turn for every sampled phrasing");
      eq(await effects(), zero, "nothing sent, approved, submitted or charged");
      // The only requests that left: posting-board reads for a pasted link (refused here); never mail, a model or Stripe.
      eq(outbound.filter((o) => !/^GET (?:boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com|boards\.greenhouse\.io|jobs\.lever\.co)$/.test(o)), [], "no request left but a board read");
    } finally {
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
