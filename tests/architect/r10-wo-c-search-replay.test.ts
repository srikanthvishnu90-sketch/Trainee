// R10 WO-C (owner order 2026-11-09; spec docs/architect/specs/APP-LAYER-15-FIXES.md A.2 job search turns 1-2, B.2, C.7, C.20,
// E.2; fixes 5, 6 and 8). The two search turns that failed on production after release 9, replayed word for word through the
// REAL handler (handler-career.ts handleChat on tests/flow: real supabase-js over the PostgREST double, Postgres 16 with every
// migration), with the staged brain released and a scripted model on the Anthropic wire ($0). Every ATS board is a fake.
//
//   S1 "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. ..."
//      production: "Nothing was invented to fill the list. Widen the role or the place and I'll search again." The role was
//      read as the whole message ("let s leave resume now find data analyst actually open show company ..."), which no
//      title holds. Now: the two open Chicago data analyst internships, numbered, each with employer, exact title, location
//      and arrangement, student window (posting's words), its application page re-checked (time in the person's zone), and
//      the link. A role closed on its board (Greenhouse 404, SmartRecruiters 404) is left out; "I did not find 5".
//   S2 "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. ..."
//      production: the graduation-window template ("The window, checked against the record."). Now: the same search WIDENED
//      (internship kept, business analyst and analytics added, Chicago suburbs and remote US added), the earlier roles kept
//      under the same numbers, no model call (a search is code's), never the template.
//   E  an empty search says the scope it checked, why nothing qualified and the one most useful widening.
// Nothing is applied for, queued or sent in any step.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { inMetro, remoteInUs, widenedAsk } from "../../supabase/functions/_shared/search_widen.ts";
import { arrangementOf, checkedAt, studentWindowOf, wantOf } from "../../supabase/functions/_shared/search_shortlist.ts";
import { linkChecker } from "../../supabase/functions/_shared/link_check.ts";
import { personZone } from "../../supabase/functions/_shared/person_zone.ts";
import { renderFeed } from "../../supabase/functions/_shared/file_page.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";
import { isBlockerAsk, withScope } from "../../supabase/functions/_shared/search_widen.ts";

const CI = Deno.env.get("CI") === "true";
const S1 = "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.";
const S2 = "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.";
// Spec F.1 (owner, 2026-11-08 6:02 pm CST, production after the limit reset): the two turns, word for word.
const F1 = "Can you try that search again now? Find 3 verified open data analyst, business analyst or analytics internships in the Chicago area or remote in the US. Include the company, exact role, location, application link and any student or graduation requirements. Don't apply to anything.";
const F2 = "I already widened the roles and location. What is actually blocking the search: no open roles found, a search connection problem, or my unconfirmed resume? Please tell me which. You can show me open postings and their requirements without deciding whether I'm eligible. Don't apply or confirm my resume for me.";
const RESEARCH = "Let's leave the job search for now. What's Stripe like to work for as a data analyst intern? Give me a useful company research answer: what its business does, what an analyst might work on, any concerns to investigate, and 5 good questions to ask in an interview. Use real sources and distinguish facts from your interpretation. Don't apply or contact anyone.";
const RESUME = "TEST Person\n\nEDUCATION\nExample University, BS Statistics, expected May 2027\n\nEXPERIENCE\nData Intern, TEST Example Co, Summer 2025\n- Built weekly SQL reports for the sales team\n\nSKILLS\nPython, SQL, Excel";
const ME = "7b0f8f8e-6a43-4a49-9d2c-000000c10001", OTHER = "7b0f8f8e-6a43-4a49-9d2c-000000c10002", F1P = "7b0f8f8e-6a43-4a49-9d2c-000000c10003";
const NB = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b", MAPLE = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", PRAIRIE = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const lit = (s: string) => `$q$${s}$q$`;
const BOARD = [
  { id: "greenhouse:acme:101", co: "Acme Freight", t: "Data Analyst Intern", loc: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/101", d: "Hybrid, three days a week in our Chicago office. Open to students graduating between December 2026 and June 2028. SQL and Python." },
  { id: "greenhouse:lake:102", co: "Lakeview Health", t: "Data Analytics Internship - Summer 2027", loc: "Chicago, Illinois, United States", url: "https://boards.greenhouse.io/lake/jobs/102", d: "Applicants must be currently enrolled in a bachelor's program. Excel and SQL." },
  { id: `lever:prairie:${PRAIRIE}`, co: "Prairie Bank", t: "Business Analyst Intern", loc: "Evanston, IL", url: `https://jobs.lever.co/prairie/${PRAIRIE}`, d: "On-site at our Evanston office. Requirements gathering and SQL." },
  { id: `ashby:northbeam:${NB}`, co: "Northbeam", t: "Analytics Intern", loc: "Remote - United States", url: `https://jobs.ashbyhq.com/northbeam/${NB}`, d: "Fully remote. Dashboards in Looker." },
  { id: "greenhouse:acme:105", co: "Acme Freight", t: "Senior Data Analyst", loc: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/105", d: "Senior role. 5+ years." },
  { id: "greenhouse:motorway:106", co: "Motorway Co", t: "Data Analyst Internship", loc: "Schaumburg, IL", url: "https://boards.greenhouse.io/motorway/jobs/106", d: "Summer internship in Schaumburg." },
  { id: "greenhouse:gone:107", co: "Gone Corp", t: "Data Analyst Intern", loc: "Chicago, IL", url: "https://boards.greenhouse.io/gone/jobs/107", d: "Closed.", closed: true },
  { id: "greenhouse:stale:108", co: "Stale Co", t: "Data Analyst Intern", loc: "Chicago, IL", url: "https://boards.greenhouse.io/stale/jobs/108", d: "Still in our index, gone from the board." },
  { id: `ashby:maple:${MAPLE}`, co: "Maple Data", t: "Analytics Intern", loc: "Remote - Canada", url: `https://jobs.ashbyhq.com/maple/${MAPLE}`, d: "Remote within Canada only." },
  { id: "smartrecruiters:quietco:7441", co: "Quiet Co", t: "Data Analyst Intern", loc: "Chicago, IL", url: "https://jobs.smartrecruiters.com/QuietCo/7441", d: "Gone from SmartRecruiters." },
  { id: "greenhouse:fulltime:109", co: "Fulltime Inc", t: "Data Analyst", loc: "Chicago, IL", url: "https://boards.greenhouse.io/fulltime/jobs/109", d: "A full-time analyst role." },
];
const wire = { chat: 0 };
const boardReads: string[] = [];
function board(u: URL): Response | null {
  if (u.host === "boards-api.greenhouse.io") { boardReads.push(u.pathname); return /\/(108)$/.test(u.pathname) ? new Response("{}", { status: 404 }) : Response.json({ id: Number(u.pathname.split("/").at(-1)) }); }
  if (u.host === "api.lever.co") { boardReads.push(u.pathname); return Response.json({ id: u.pathname.split("/").at(-1) }); }
  if (u.host === "api.ashbyhq.com") { boardReads.push(u.pathname); return Response.json({ jobs: /northbeam/.test(u.pathname) ? [{ id: NB }] : /maple/.test(u.pathname) ? [{ id: MAPLE }] : [] }); }
  // architect amendment E.21 (2026-11-10): a search checks an Ashby posting on its own page by id, never the board listing. The
  // posting page answers from the same truth as the listing above (open while the listing holds its id, else 404).
  if (u.host === "jobs.ashbyhq.com") {
    boardReads.push(u.pathname);
    const [, b, id] = u.pathname.split("/");
    const listed = b === "northbeam" ? [NB] : b === "maple" ? [MAPLE] : [];
    return listed.some((x) => x.toLowerCase() === String(id ?? "").toLowerCase()) ? new Response("<html>open</html>") : new Response("", { status: 404 });
  }
  if (u.host === "api.smartrecruiters.com") { boardReads.push(u.pathname); return new Response("{}", { status: 404 }); }
  return null;
}

Deno.test("WO-C units: the S1 role is the asked role; S2 widens the last search; metro, remote US, windows, zones, counts", async () => {
  assertNode.equal(searchTextOf(S1).role, "data analyst");
  assertNode.deepEqual(searchTextOf(S1).limits.bands, ["intern"]);
  const prev = { role: "data analyst", place: "chicago", remote: false, limits: { bands: ["intern" as const], pay: null, company: null, term: null, needsSponsor: false } };
  const w = widenedAsk(S2, { lastAsk: prev, lastAskAt: 1000, lastShortlist: [{ id: "greenhouse:acme:101" }] }, 2000)!;
  assertNode.deepEqual(w.ask.roles, ["data analyst", "business analyst", "analytics"]);
  assertNode.equal(w.ask.place, "chicago"); assertNode.equal(w.ask.area, true); assertNode.equal(w.ask.remote, true); assertNode.equal(w.ask.remoteRegion, "us");
  assertNode.deepEqual(w.ask.limits?.bands, ["intern"], "the internship level is kept");
  assertNode.deepEqual(w.ask.keep, ["greenhouse:acme:101"], "the earlier roles keep their numbers");
  assertNode.equal(widenedAsk(S2, { lastAsk: prev, lastAskAt: 1000 }, 1000 + 31 * 60_000), null, "an old search is not widened");
  assertNode.equal(widenedAsk("what should I include in my cover letter?", { lastAsk: prev, lastAskAt: 1000 }, 2000), null, "not a widening");
  assertNode.ok(inMetro("Evanston, IL", "chicago") && inMetro("Schaumburg, Illinois", "chicago") && !inMetro("Springfield, IL", "chicago"));
  assertNode.ok(remoteInUs("Remote - United States") && remoteInUs("Remote") && !remoteInUs("Remote - Canada"));
  assertNode.equal(studentWindowOf("Hybrid. Open to students graduating between December 2026 and June 2028. SQL."), "Open to students graduating between December 2026 and June 2028.");
  assertNode.equal(studentWindowOf("SQL and Python."), null);
  assertNode.equal(wantOf(S1), 5); assertNode.equal(wantOf(S2), null); assertNode.equal(wantOf(F1), 3);
  // F.1: one sentence naming three titles and two places is that whole scope; the blocker question is recognised.
  const f1 = withScope({ role: "data analyst business analyst analytics", place: null, remote: true }, F1);
  assertNode.deepEqual([f1.roles, f1.place, f1.area, f1.remoteRegion], [["data analyst", "business analyst", "analytics"], "chicago", true, "us"]);
  assertNode.ok(isBlockerAsk(F2) && !isBlockerAsk(S1) && !isBlockerAsk(RESEARCH));
  // F.1/F.2: the ack names the turn's real intent (production said "looking for roles now" to company research).
  assertNode.equal(ackFor(RESEARCH), "on it — researching that now");
  assertNode.equal(ackFor(F2), "on it — checking that now");
  assertNode.equal(ackFor(F1), "on it — looking for roles now");
  assertNode.equal(ackFor("I'm not asking for an application batch. I only want company research about Stripe. If you can't research it, name the specific blocker instead of explaining how to apply."), "on it — researching that now");
  assertNode.equal(checkedAt(Date.parse("2026-11-08T23:16:00Z"), "America/Chicago").text, "Nov 8, 5:16 PM CST");
  assertNode.deepEqual(checkedAt(Date.parse("2026-11-08T23:16:00Z"), null), { text: "Nov 8, 11:16 PM UTC", zoneKnown: false });
  assertNode.deepEqual(personZone({ alertTz: null, location: "Chicago, IL" }), { tz: "America/Chicago", city: "Chicago" });
  assertNode.equal(personZone({ alertTz: null, location: null }), null);
  // Fix 6: Ashby and SmartRecruiters postings are checked on their own public boards; Greenhouse and Lever by id as before.
  const seen: string[] = [];
  const f = (async (u: string) => { seen.push(u); return board(new URL(u)) ?? new Response("", { status: 500 }); }) as unknown as typeof fetch;
  const check = linkChecker(f);
  assertNode.equal(await check({ job_id: `ashby:northbeam:${NB}` }), "live");
  assertNode.equal(await check({ job_id: "ashby:northbeam:11111111-2222-4333-8444-555555555555" }), "dead");
  assertNode.equal(await check({ job_id: "smartrecruiters:quietco:7441" }), "dead");
  assertNode.ok(seen.includes("https://api.ashbyhq.com/posting-api/job-board/northbeam") && seen.includes("https://api.smartrecruiters.com/v1/companies/quietco/postings/7441"), seen.join(" "));
  // Architect review (2026-11-09) 6-b: each Ashby board is read once per checker, however many of its postings are checked.
  assertNode.equal(seen.filter((u) => u.endsWith("/job-board/northbeam")).length, 1, "one read of the Ashby board");
  const big = { jobs: Array.from({ length: 2000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) };
  let reads = 0;
  const bigCheck = linkChecker((async () => { reads++; return Response.json(big); }) as unknown as typeof fetch);
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) assertNode.equal(await bigCheck({ job_id: `ashby:bigco:00000000-0000-4000-8000-${String(i * 7).padStart(12, "0")}` }), "live");
  assertNode.equal(reads, 1, "40 postings on one 2,000-job board: one read");
  assertNode.ok(performance.now() - t0 < 500, `40 checks on one board in under 0.5 s (${Math.round(performance.now() - t0)} ms)`);
  // 4-c: region and area words never end up in the role; 5-b: a bare "Remote" names no region; 6-c: "U.S." is not a sentence end.
  assertNode.equal(searchTextOf("Find business analyst roles remote in the U.S.").role, "business analyst");
  assertNode.equal(searchTextOf("us analytics internships").role, "analytics");
  assertNode.equal(searchTextOf("data analyst jobs in the Chicago area").role, "data analyst");
  assertNode.equal(arrangementOf("Remote", ""), "remote, region not stated");
  assertNode.equal(arrangementOf("Remote - United States", ""), "remote");
  assertNode.equal(studentWindowOf("Interns work in the U.S. office. Open to students graduating in the U.S. between May 2027 and June 2028. SQL."), "Open to students graduating in the U.S. between May 2027 and June 2028.");
  // 10: the alert settings' default zone is not a zone the person stated.
  assertNode.equal(personZone({ alertTz: "America/New_York", location: null }), null);
});

Deno.test("WO-C fix 8: the shortlist File card carries the student window and the open check, stacked, no wide table", () => {
  const job = { job_id: "greenhouse:acme:101", company: "Acme Freight", title: "Data Analyst Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/101", pay: null, level: null, remote: null,
    posted_at: null, first_seen_at: null, deadline: null, source: "greenhouse", reasons: [], gaps: [], company_domain: null };
  const html = renderFeed({ token: "t", rows: [{ ref: "r1", job, logo: null, snippet: "Hybrid", full: "x", status: null, inApps: false, tag: null, resume: null, byHand: false, blocked: null,
    window: 'Student window: "Open to students graduating between December 2026 and June 2028"', openLine: "Open: application page checked Nov 8, 5:16 PM CST" } as any], setHash: null, setSize: 0, top: null, og: null as any, total: 1 } as any);
  assertNode.ok(html.includes("Student window: &quot;Open to students graduating between December 2026 and June 2028&quot;") || html.includes('Student window: "Open to students graduating'), "the window is on the card");
  assertNode.ok(html.includes("Open: application page checked Nov 8, 5:16 PM CST"), "the check is on the card");
  assertNode.ok(!/<table/i.test(html), "no table");
});

Deno.test({
  name: "WO-C replay: production S1 and S2 through the real handler on real Postgres (staged brain, scripted model, fake boards)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS",
      "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL", "CAREER_APPLY_ALL_YES"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error;
    try {
      await supabaseParity(pg);
      const prefs = JSON.stringify({ on: false, keywords: ["data analyst"], locations: [], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 });
      await pg.sql(`insert into auth.users (id, email) values ('${ME}', 'c1@example.test'), ('${OTHER}', 'c2@example.test'), ('${F1P}', 'c3@example.test');
        insert into public.profiles (id) values ('${ME}'), ('${OTHER}'), ('${F1P}');
        insert into public.career_watch_kv (user_id, key, value) values ('${ME}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${OTHER}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${F1P}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) values ('${ME}', 'America/Chicago', ${lit(prefs)}::jsonb, now());
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at, closed_at) values
        ${BOARD.map((b) => `(${lit(b.id)}, ${lit(b.id.split(":")[0])}, ${lit(b.id.split(":")[1])}, ${lit(b.co)}, ${lit(b.t)}, ${lit(b.loc)}, ${lit(b.url)}, ${lit(b.d)}, now() - interval '2 days', now(), ${(b as any).closed ? "now()" : "null"})`).join(",\n")};
        -- Architect review (2026-11-09) 5/F.1-a: production holds ~13,900 open "data analyst" postings, and the newest 300 held
        -- none of the Chicago or remote internships. 6,000 newer data analyst postings elsewhere stand in for them here.
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
          select 'greenhouse:noise:' || g, 'greenhouse', 'noise', 'TEST Noise ' || g, case when g % 3 = 0 then 'Data Analyst Intern' else 'Senior Data Analyst' end,
            (array['Austin, TX', 'Denver, CO', 'Remote - Canada', 'London, UK', 'Seattle, WA'])[1 + g % 5], 'https://boards.greenhouse.io/noise/jobs/' || g,
            'A data analyst role. SQL and Python.', now() - (g || ' seconds')::interval, now()
          from generate_series(1, 6000) g;`);
      h = await careerHandler(pg, { me: ME, other: OTHER, f1: F1P });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => { wire.chat++; return Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "A model reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } }); });
        const ats = board(u);
        if (ats) return ats;
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      // As production: the staged brain released, a model key configured (the scripted wire answers; nothing is spent).
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const n = async (sql: string) => Number(await pg.sql(sql));
      const effects = async () => ({ jobs: await n(`select count(*) from public.career_apply_jobs`), wanted: await n(`select count(*) from public.career_apply_wanted`), send: await n(`select count(*) from public.career_send_queue`) });
      const zero = await effects();
      const me = h.chat("me");
      const say = async (c: ReturnType<NonNullable<typeof h>["chat"]>, m: string) => { await pg.sql(`delete from public.agent_rate_limits`); const r = await c.say(m); assertNode.equal(r.status, 200, r.reply); return r; };
      const items = (reply: string) => reply.split("\n").filter((l) => /^\d+\. /.test(l));
      const block = (reply: string, i: number) => { const lines = reply.split("\n"), k = lines.findIndex((l) => l.startsWith(`${i}. `)); return k < 0 ? "" : [lines[k], ...lines.slice(k + 1).filter((_, j, a) => a.slice(0, j + 1).every((x) => /^\s{3}/.test(x)))].join("\n"); };

      let s1Items: string[] = [];
      await t.step("S1: the open Chicago data analyst internships, each usable; closed ones left out; fewer than 5 said", async () => {
        const r = await say(me, S1);
        console.log(`--- S1 reply (${r.intent})\n${r.reply}`);
        assertNode.ok(!/^\s*Nothing was invented to fill the list\. Widen the role/.test(r.reply), "not the bare production reply");
        assertNode.ok(!/let s leave|application link don t/i.test(r.reply), "the role is the asked role, not the whole message");
        s1Items = items(r.reply);
        assertNode.equal(s1Items.length, 2, r.reply);
        assertNode.match(s1Items[0], /^1\. Data Analyst Intern at Acme Freight — Chicago, IL, hybrid/);
        assertNode.match(s1Items[1], /^2\. Data Analytics Internship - Summer 2027 at Lakeview Health — Chicago, Illinois, United States/);
        const one = block(r.reply, 1), two = block(r.reply, 2);
        assertNode.match(one, /Student window: "Open to students graduating between December 2026 and June 2028"/);
        assertNode.match(two, /Student window: "Applicants must be currently enrolled in a bachelor's program"/);
        for (const b of [one, two]) {
          assertNode.match(b, /\n   Checked: open on the Greenhouse board, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M C[SD]T\.$/, "checked on its board, the time in the person's zone (Chicago)");
          assertNode.match(b.split("\n")[0], /\(https:\/\/boards\.greenhouse\.io\/(acme|lake)\/jobs\/10[12]\)/, "the application link on the numbered line");
          assertNode.match(b, /\n   Uncertain: your graduation date isn't confirmed, so eligibility isn't decided\./, "a missing fact is named beside the role, never an eligibility verdict");
        }
        assertNode.match(r.reply, /I did not find 5 within the scope checked/);
        assertNode.ok(!/apply to these|Reply yes and I'll apply/i.test(r.reply), "after \"Don't apply yet\" no offer to apply follows the list (architect ruling 5)");
        assertNode.match(r.reply, /2 roles were left out: closed when checked/);
        assertNode.match(r.reply, /Nothing was applied for/);
        for (const never of ["Stale Co", "Quiet Co", "Gone Corp", "Senior Data Analyst", "Fulltime Inc", "Motorway Co"]) assertNode.ok(!r.reply.includes(never), `${never} is not listed in S1`);
      });

      await t.step("S2: the same search widened, earlier roles under the same numbers, never the graduation-window template, no model call", async () => {
        const before = wire.chat;
        const r = await say(me, S2);
        console.log(`--- S2 reply (${r.intent})\n${r.reply}`);
        assertNode.ok(!/The window, checked against the record|I cannot answer that from the record/.test(r.reply), "never the graduation-window template");
        assertNode.equal(r.intent, "career_discovery");
        assertNode.equal(wire.chat, before, "a widened search is code's: no model call");
        const list = items(r.reply);
        assertNode.deepEqual(list.slice(0, 2), s1Items, "the earlier verified roles keep their numbers");
        const rest = list.slice(2).join("\n");
        for (const want of ["Data Analyst Internship at Motorway Co — Schaumburg, IL", "Business Analyst Intern at Prairie Bank — Evanston, IL, on-site", "Analytics Intern at Northbeam — Remote - United States, remote"]) assertNode.ok(rest.includes(want), `${want} | ${r.reply}`);
        assertNode.equal(list.length, 5, r.reply);
        assertNode.match(r.reply, /^I verified 5 open matches\. 4 are in the Chicago area and 1 is remote in the US\./m);
        for (const never of ["Maple Data", "Stale Co", "Quiet Co", "Gone Corp", "Senior Data Analyst", "Fulltime Inc"]) assertNode.ok(!r.reply.includes(never), `${never} is not listed in S2`);
        assertNode.match(r.reply, /Nothing was applied for/);
      });

      await t.step("E: an empty search names the scope checked, why nothing qualified, and the most useful widening", async () => {
        const r = await say(h!.chat("other"), "Find me 3 economist internships in Peoria. Show the links.");
        console.log(`--- E reply (${r.intent})\n${r.reply}`);
        // Architect amendment (D-058, 2026-11-11, owner's "same length as Instinct"): the short empty-search form: one clause of scope and one widening offer
        // in the reply; the refresh time, "Nothing was invented" and "nothing was applied for" are the turn's proof (D-024), asserted here.
        assertNode.match(r.reply, /^I checked economist internships in Peoria on the live board and the saved job-board snapshot: no open roles\./);
        assertNode.match(r.reply, /Say "include remote US" to widen to remote roles in the US\./);
        const proof = r.body?.meta?.search_proof;
        assertNode.match(String(proof?.checked), /^I checked economist internships in Peoria, on the live board \(last refreshed [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M UTC\) and the saved snapshot of job boards$/);
        assertNode.match(String(proof?.result), /^none was found/);
        assertNode.equal(proof?.invented, "Nothing was invented to fill the list.");
        assertNode.equal(proof?.applied, "Nothing was applied for.");
        assertNode.ok(!/applied|submitted|queued/i.test(r.reply.replace(/\bapplication\b/gi, "")), "the reply claims no action");
        assertNode.equal(items(r.reply).length, 0);
      });

      await t.step("F.1: the post-reset turns: one scope of three titles and two places; no resume tail; the evidenced blocker", async () => {
        const c = h!.chat("f1");
        const pasted = await say(c, RESUME);
        console.log(`--- F.1 resume paste (${pasted.intent})\n${pasted.reply.slice(0, 300)}`);
        assertNode.equal(pasted.intent, "career_resume_ingest", "the resume is read and waits for the person's word (unconfirmed, as in production)");
        const r1 = await say(c, F1);
        console.log(`--- F.1 turn 1 (${r1.intent})\n${r1.reply}`);
        assertNode.ok(!/nothing is sent anywhere before your resume is confirmed/i.test(r1.reply), "a search never carries the resume-confirmation tail");
        const list = items(r1.reply);
        // "Find 3": three roles, each one that fits the whole scope (three titles, the Chicago area or remote in the US).
        assertNode.equal(list.length, 3, r1.reply);
        assertNode.ok(list.every((l) => /Acme Freight|Lakeview Health|Motorway Co|Prairie Bank|Northbeam/.test(l)), r1.reply);
        for (const never of ["Maple Data", "Stale Co", "Quiet Co", "Fulltime Inc"]) assertNode.ok(!r1.reply.includes(never), never);
        const r2 = await say(c, F2);
        console.log(`--- F.1 turn 2 (${r2.intent})\n${r2.reply}`);
        assertNode.ok(!/Eligibility can't be graded|Paste the posting text/.test(r2.reply), "never the eligibility lecture, never asks for a posting");
        assertNode.match(r2.reply, /^Nothing is blocking it: \d+ open roles are listed below\. Your resume isn't confirmed, and that doesn't block a search/);
        assertNode.equal(items(r2.reply).length, list.length, "the same listing, shown again");
        assertNode.ok(!/nothing is sent anywhere before your resume is confirmed/i.test(r2.reply));
        // The same blocker question after a search that found nothing names that blocker, with its scope.
        const o = h!.chat("other");
        await say(o, "Find me 3 economist internships in Peoria. Show the links.");
        const r3 = await say(o, "What is actually blocking the search: no open roles found, a search connection problem, or my unconfirmed resume?");
        console.log(`--- F.1 blocker after an empty search (${r3.intent})\n${r3.reply}`);
        assertNode.match(r3.reply, /^What blocked it: no open roles were found in the scope I checked\. It was not a connection problem \(the job boards were read\), and not your resume/);
        assertNode.match(r3.reply, /I checked economist internships in Peoria/);
      });

      assertNode.deepStrictEqual(await effects(), zero, "nothing applied for, queued or sent");
      assertNode.deepStrictEqual(outbound, [], "no request left but the fake boards");
      assertNode.ok(boardReads.some((p) => /\/108$/.test(p)) && boardReads.some((p) => /postings\/7441$/.test(p)), "the closed roles were re-checked on their boards");
    } finally {
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
