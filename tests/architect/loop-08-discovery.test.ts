// Release item 8 (job discovery) loop: docs/architect/VERIFICATION-15.md, criteria docs/architect/specs/APP-LAYER-15-FIXES.md
// E.2 (14-24). A battery of search requests replayed through the REAL handler (handler-career.ts handleChat on tests/flow:
// real supabase-js over the PostgREST double, Postgres 16 with every migration), staged brain, scripted model on the
// Anthropic wire ($0). The job boards are fakes with a known truth for every posting:
//
//   open      live on its board                          may be shown, as checked open
//   closed    closed_at set in our index                 never shown
//   dead      open in our index, gone from its board     never shown (404, or missing from the Ashby list)
//   blocked   its board answers 500                      may be shown only marked as not re-checked (E.22)
//
// across Greenhouse, Lever, Ashby and SmartRecruiters, four roles, six places, intern and full-time levels, plus 2,000 newer
// noise postings. Every numbered posting in every reply is scored:
//
//   invented            its link is not a posting on any fixture board                       bar: 0
//   dead                its posting is closed or gone from its board                         bar: 0
//   unmarked_unchecked  a blocked-board posting shown without saying it was not re-checked   bar: 0
//   count_dishonest     "I verified N" differs from the rows checked open, more rows than asked, or fewer than asked
//                       without saying so                                                    bar: 0
//   empty_no_scope      an empty result that does not name the scope checked and a widening  bar: 0
//   off_scope           a posting outside the asked role, level or place (E.14)              reported
//   missed              in-scope open postings not shown while the reply listed fewer than asked   reported
//
// Architect ruling E.21 (the default): every search re-checks the postings it shows, only those, at most the count asked and
// never more than 10, each on its own posting page by id, and never reads a board listing (a closed one's place goes to the
// next posting, which is then checked; at most 10 pages per search). The battery runs as shipped and must meet every bar; each
// search's page reads are counted (at most the rows shown plus the closed ones said left out, never over 10).
//
// Run: deno test -A --no-check tests/architect/loop-08-discovery.test.ts (Postgres 16; LOOP_OUT=<dir> keeps the transcripts).
// Nothing is applied for, queued or sent.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { type LoopCase, reportLoop } from "./helpers/loop_report.ts";

const CI = Deno.env.get("CI") === "true";
const lit = (s: string) => `$q$${s}$q$`;

type Truth = "open" | "closed" | "dead" | "blocked";
type Provider = "greenhouse" | "lever" | "ashby" | "smartrecruiters";
interface Posting { id: string; provider: Provider; board: string; native: string; co: string; title: string; loc: string; place: string; intern: boolean; role: string; truth: Truth; url: string; d: string }

const ROLES = [
  { role: "data analyst", intern: "Data Analyst Intern", full: "Data Analyst" },
  { role: "software engineer", intern: "Software Engineer Intern", full: "Software Engineer" },
  { role: "product manager", intern: "Product Manager Intern", full: "Product Manager" },
  { role: "marketing coordinator", intern: "Marketing Coordinator Intern", full: "Marketing Coordinator" },
];
const PLACES = [
  { place: "chicago", loc: "Chicago, IL" },
  { place: "chicago-metro", loc: "Evanston, IL" },
  { place: "austin", loc: "Austin, TX" },
  { place: "seattle", loc: "Seattle, WA" },
  { place: "remote-us", loc: "Remote - United States" },
  { place: "remote-ca", loc: "Remote - Canada" },
];
const CYCLE: Truth[] = ["open", "open", "closed", "dead", "blocked", "open", "dead", "open"];
const PROVIDERS: Provider[] = ["greenhouse", "lever", "ashby", "smartrecruiters"];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function fixtureBoards(): Posting[] {
  const out: Posting[] = [];
  let n = 0;
  for (const r of ROLES) for (const p of PLACES) for (const intern of [true, false]) {
    n++;
    const truth = CYCLE[n % CYCLE.length], provider = PROVIDERS[n % PROVIDERS.length];
    // A blocked board is its own board, so blocking it never blocks an open posting's board.
    const board = truth === "blocked" ? `walled${n}` : `co${n}`;
    const native = provider === "greenhouse" || provider === "smartrecruiters" ? String(4000 + n) : uuid(n);
    const url = provider === "greenhouse" ? `https://boards.greenhouse.io/${board}/jobs/${native}`
      : provider === "lever" ? `https://jobs.lever.co/${board}/${native}`
      : provider === "ashby" ? `https://jobs.ashbyhq.com/${board}/${native}`
      : `https://jobs.smartrecruiters.com/${board}/${native}`;
    out.push({ id: `${provider}:${board}:${native}`, provider, board, native, co: `TEST Loop Co ${n}`, title: intern ? r.intern : r.full, loc: p.loc, place: p.place, intern, role: r.role, truth, url,
      d: `${intern ? "Summer 2027 internship. " : "Full-time role. "}${p.place.startsWith("remote") ? "Fully remote." : "On-site."} Requirements are in the posting.` });
  }
  return out;
}
const POSTINGS = fixtureBoards();
const BY_URL = new Map(POSTINGS.map((p) => [p.url, p]));

// The fake boards: each answers only from the truth table.
const boardReads: string[] = [];
function board(u: URL): Response | null {
  const find = (provider: Provider, b: string, native: string) => POSTINGS.find((p) => p.provider === provider && p.board === b && p.native.toLowerCase() === native.toLowerCase());
  const answer = (p: Posting | undefined, ok: () => Response) => !p || p.truth === "dead" || p.truth === "closed" ? new Response("{}", { status: 404 }) : p.truth === "blocked" ? new Response("blocked", { status: 500 }) : ok();
  if (u.host === "boards-api.greenhouse.io") { boardReads.push(u.href); const [, , , b, , id] = u.pathname.split("/"); return answer(find("greenhouse", b, id), () => Response.json({ id: Number(id) })); }
  if (u.host === "api.lever.co") { boardReads.push(u.href); const [, , , b, id] = u.pathname.split("/"); return answer(find("lever", b, id), () => Response.json({ id })); }
  if (u.host === "api.smartrecruiters.com") { boardReads.push(u.href); const [, , , b, , id] = u.pathname.split("/"); return answer(find("smartrecruiters", b, id), () => Response.json({ id })); }
  if (u.host === "api.ashbyhq.com") {
    boardReads.push(u.href);
    const b = u.pathname.split("/").at(-1)!, on = POSTINGS.filter((p) => p.provider === "ashby" && p.board === b);
    if (on.some((p) => p.truth === "blocked")) return new Response("blocked", { status: 500 });
    return Response.json({ jobs: on.filter((p) => p.truth === "open" || p.truth === "blocked").map((p) => ({ id: p.native })) });
  }
  return null;
}

interface Ask { id: string; text: string; role: string | null; places: string[]; metro: string[]; intern: boolean; want: number | null; empty?: boolean }
function asks(): Ask[] {
  const out: Ask[] = [];
  for (const r of ROLES) {
    const R = r.role;
    out.push({ id: `${R}/chicago/intern/3`, text: `Find me 3 ${R} internships in Chicago that are actually open. Show the company, role, location and link. Don't apply yet.`, role: R, places: ["chicago"], metro: ["chicago-metro"], intern: true, want: 3 });
    out.push({ id: `${R}/austin/any`, text: `Find ${R} jobs in Austin, TX. Show the company, role and application link.`, role: R, places: ["austin"], metro: [], intern: false, want: null });
    out.push({ id: `${R}/remote-us/any/5`, text: `Find 5 ${R} roles remote in the US. Show the real links.`, role: R, places: ["remote-us"], metro: [], intern: false, want: 5 });
    out.push({ id: `${R}/seattle/intern`, text: `Show me open ${R} internships in Seattle. Don't apply to anything.`, role: R, places: ["seattle"], metro: [], intern: true, want: null });
    out.push({ id: `${R}/chicago-area/any/2`, text: `Find 2 ${R} jobs in the Chicago area.`, role: R, places: ["chicago", "chicago-metro"], metro: [], intern: false, want: 2 });
  }
  out.push({ id: "empty/economist/peoria", text: "Find me 3 economist internships in Peoria. Show the links.", role: null, places: [], metro: [], intern: true, want: 3, empty: true });
  out.push({ id: "empty/marine-biologist/boise", text: "Find marine biologist jobs in Boise, Idaho.", role: null, places: [], metro: [], intern: false, want: null, empty: true });
  out.push({ id: "empty/data-analyst/anchorage", text: "Find 4 data analyst internships in Anchorage, Alaska.", role: null, places: [], metro: [], intern: true, want: 4, empty: true });
  return out;
}

const items = (reply: string) => reply.split("\n").filter((l) => /^\d+\. /.test(l));
const block = (reply: string, i: number) => {
  const lines = reply.split("\n"), k = lines.findIndex((l) => l.startsWith(`${i}. `));
  if (k < 0) return "";
  const rest: string[] = [];
  for (const l of lines.slice(k + 1)) { if (/^\s{3}/.test(l)) rest.push(l); else break; }
  return [lines[k], ...rest].join("\n");
};
const urlOf = (line: string) => /\((https?:\/\/[^\s)]+)\)/.exec(line)?.[1] ?? /(https?:\/\/\S+)/.exec(line)?.[1]?.replace(/[).,]+$/, "") ?? null;

export function score(a: Ask, reply: string) {
  const faults: string[] = [], list = items(reply);
  const n = { shown: list.length, invented: 0, dead: 0, unmarked_unchecked: 0, count_dishonest: 0, empty_no_scope: 0, off_scope: 0, missed: 0, checked_open: 0 };
  const shown = new Set<string>();
  list.forEach((line, i) => {
    const b = block(reply, i + 1), url = urlOf(line), p = url ? BY_URL.get(url) : undefined;
    if (!url || !p) { n.invented++; faults.push(`invented: ${line.slice(0, 120)}`); return; }
    shown.add(p.id);
    if (p.truth === "closed" || p.truth === "dead") { n.dead++; faults.push(`dead (${p.truth}): ${p.id}`); }
    const saysOpen = /Checked: open on/i.test(b);
    if (saysOpen) n.checked_open++;
    if (p.truth === "blocked" && (saysOpen || !/could not (?:re-)?check|not re-checked|couldn['’]t (?:re-)?check|not checked|unconfirmed|limited check/i.test(b))) { n.unmarked_unchecked++; faults.push(`blocked board shown as checked or unmarked: ${p.id}`); }
    const placeOk = a.places.includes(p.place) || a.metro.includes(p.place);
    if ((a.role && p.role !== a.role) || (a.intern && !p.intern) || !placeOk) { n.off_scope++; faults.push(`off scope: ${p.title} ${p.loc} for ${a.id}`); }
  });
  const verified = /I verified (\d+|one|two|three|four|five|six|seven|eight|nine|ten) open match/i.exec(reply)?.[1];
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const v = verified ? (words[verified.toLowerCase()] ?? Number(verified)) : null;
  // Without the open check the count is "N listed, not re-checked": N must be the rows, and none may say checked open.
  const unchecked = /^(\d+) listed, not re-checked\./m.exec(reply)?.[1];
  if (list.length && (unchecked ? Number(unchecked) !== list.length || n.checked_open > 0 : v !== n.checked_open)) { n.count_dishonest++; faults.push(`count: says ${v ?? unchecked ?? "no count"}, ${n.checked_open} rows checked open of ${list.length}`); }
  if (a.want && list.length > a.want) { n.count_dishonest++; faults.push(`count: ${list.length} shown for ${a.want} asked`); }
  if (a.want && list.length && list.length < a.want && !new RegExp(`did not find ${a.want}\\b`).test(reply)) { n.count_dishonest++; faults.push(`count: ${list.length} of ${a.want} without saying so`); }
  if (!list.length && !(/I checked .+ in .+/.test(reply) && /widening|widen/i.test(reply))) { n.empty_no_scope++; faults.push("empty without scope and widening"); }
  if (!a.empty && a.role) {
    const truthOpen = POSTINGS.filter((p) => p.role === a.role && (!a.intern || p.intern) && a.places.includes(p.place) && p.truth === "open");
    const cap = a.want ?? 5;
    if (list.length < cap) n.missed += truthOpen.filter((p) => !shown.has(p.id)).length;
    if (n.missed) faults.push(`missed ${n.missed} in-scope open posting(s)`);
  }
  return { n, faults };
}

Deno.test("loop 8 scorer: invented, dead, unmarked and dishonest counts are caught", () => {
  const open = POSTINGS.find((p) => p.truth === "open" && p.role === "data analyst" && p.place === "chicago" && p.intern)!;
  const dead = POSTINGS.find((p) => p.truth === "dead")!;
  const a: Ask = { id: "t", text: "", role: "data analyst", places: ["chicago"], metro: [], intern: true, want: 3 };
  const good = score(a, `I verified 1 open match. I did not find 3 within the scope checked.\n1. ${open.title} at ${open.co} — ${open.loc} (${open.url}).\n   Checked: open on the board, Nov 9.`);
  assertNode.deepEqual([good.n.invented, good.n.dead, good.n.count_dishonest], [0, 0, 0], good.faults.join("; "));
  const bad = score(a, `I verified 3 open matches.\n1. Made Up at Nowhere (https://example.com/job/1).\n2. ${dead.title} (${dead.url}).\n   Checked: open on the board.`);
  assertNode.equal(bad.n.invented, 1); assertNode.equal(bad.n.dead, 1); assertNode.ok(bad.n.count_dishonest >= 1);
  assertNode.equal(score({ ...a, empty: true }, "Nothing found.").n.empty_no_scope, 1);
  assertNode.ok(POSTINGS.filter((p) => p.truth === "blocked").length >= 4 && POSTINGS.filter((p) => p.truth === "dead").length >= 8, "the fixture has every kind");
});

Deno.test({
  name: "loop 8: job discovery through the real handler: 0 invented or dead postings, honest counts, empty results give their scope",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS",
      "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL", "CAREER_APPLY_ALL_YES", "CAREER_SEARCH_OPEN_CHECK"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error;
    const ASKS = asks();
    const MODES = ["shipped"] as const;
    const people = Object.fromEntries(MODES.flatMap((m, k) => ASKS.map((_, i) => [`${m}${i}`, `8e0f8f8e-6a43-4a49-9d2c-${String(800000000000 + k * 100 + i)}`])));
    try {
      await supabaseParity(pg);
      const ids = Object.values(people);
      await pg.sql(`insert into auth.users (id, email) values ${ids.map((id) => `('${id}', '${id}@example.test')`).join(", ")};
        insert into public.profiles (id) values ${ids.map((id) => `('${id}')`).join(", ")};
        insert into public.career_watch_kv (user_id, key, value) values ${ids.map((id) => `('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}')`).join(", ")};
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at, closed_at) values
        ${POSTINGS.map((p) => `(${lit(p.id)}, ${lit(p.provider)}, ${lit(p.board)}, ${lit(p.co)}, ${lit(p.title)}, ${lit(p.loc)}, ${lit(p.url)}, ${lit(p.d)}, now() - interval '1 day', now(), ${p.truth === "closed" ? "now()" : "null"})`).join(",\n")};
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
          select 'greenhouse:noise:' || g, 'greenhouse', 'noise', 'TEST Noise ' || g, (array['Senior Data Analyst', 'Staff Software Engineer', 'Director of Product', 'Marketing Manager'])[1 + g % 4],
            (array['Denver, CO', 'London, UK', 'Remote - Canada', 'Miami, FL'])[1 + (g / 4) % 4], 'https://boards.greenhouse.io/noise/jobs/' || g,
            'A senior role.', now() - (g || ' seconds')::interval, now()
          from generate_series(1, 2000) g;`);
      h = await careerHandler(pg, people);
      const viaDouble = globalThis.fetch, outbound: string[] = [], pageReads: string[] = [], checkFaults: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host !== new URL(SUPABASE_URL).host && u.host !== "api.anthropic.com") pageReads.push(u.href);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "A model reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));
        const ats = board(u);
        if (ats) return ats;
        // A posting page fetched directly (no board API) answers from the same truth.
        const p = BY_URL.get(u.href);
        if (p) return p.truth === "open" ? new Response("<html>open</html>") : p.truth === "blocked" ? new Response("", { status: 500 }) : new Response("", { status: 404 });
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const n = async (sql: string) => Number(await pg.sql(sql));
      const effects = async () => ({ jobs: await n(`select count(*) from public.career_apply_jobs`), wanted: await n(`select count(*) from public.career_apply_wanted`), send: await n(`select count(*) from public.career_send_queue`) });
      const zero = await effects();

      const pass = async (mode: typeof MODES[number]) => {
        const totals: Record<string, number> = { cases: ASKS.length, shown: 0, invented: 0, dead: 0, unmarked_unchecked: 0, count_dishonest: 0, empty_no_scope: 0, off_scope: 0, missed: 0, checked_open: 0 };
        const cases: LoopCase[] = [];
        for (const [i, a] of ASKS.entries()) {
          await pg.sql(`delete from public.agent_rate_limits`);
          pageReads.length = 0;
          const r = await h!.chat(`${mode}${i}`).say(a.text);
          assertNode.equal(r.status, 200, r.reply);
          const s = score(a, r.reply);
          // E.21: one page per posting about to be shown: at most the rows shown plus the closed ones said left out (each place
          // goes to the next posting), never more than 10 pages, and never a board's listing (the Ashby job-board list).
          const closedSaid = Number(/(\d+) (?:matching )?roles? (?:was|were) (?:left out: closed when checked|found, but)/.exec(r.reply)?.[1] ?? 0);
          const cap = Math.min(s.n.shown + closedSaid, 10), lists = pageReads.filter((u) => /\/posting-api\/job-board\//.test(u));
          if (pageReads.length > cap) s.faults.push(`checks: ${pageReads.length} pages read for at most ${cap}`);
          if (lists.length) s.faults.push(`board listing read: ${lists.join(" ")}`);
          if (pageReads.length > cap || lists.length) checkFaults.push(`${a.id}: ${pageReads.length} pages, ${lists.length} listings`);
          for (const [k, v] of Object.entries(s.n)) totals[k] += v;
          cases.push({ id: `${mode}/${a.id}`, asked: a.text, reply: r.reply, intent: r.intent, faults: s.faults });
        }
        const ok = totals.invented === 0 && totals.dead === 0 && totals.unmarked_unchecked === 0 && totals.count_dishonest === 0 && totals.empty_no_scope === 0;
        await reportLoop({ item: 8, file: `8-${mode}`, name: `discovery-open-check-${mode}`, numbers: totals, bar: "invented+dead+unmarked_unchecked+count_dishonest+empty_no_scope == 0", pass: ok, cases });
        return totals;
      };
      const totals = await pass("shipped");
      assertNode.deepStrictEqual(checkFaults, [], "each search checks only the postings it shows, by page, and reads no board listing");
      assertNode.deepStrictEqual(await effects(), zero, "nothing applied for, queued or sent");
      assertNode.deepStrictEqual(outbound, [], "no request left but the fake boards");
      assertNode.ok(totals.shown > 0, "the battery listed postings at all");
      assertNode.equal(totals.invented, 0, "0 invented postings");
      assertNode.equal(totals.dead, 0, "0 dead postings");
      assertNode.equal(totals.unmarked_unchecked, 0, "a posting whose board could not be read is never called checked");
      assertNode.equal(totals.count_dishonest, 0, "every count is the listed rows");
      assertNode.equal(totals.empty_no_scope, 0, "every empty result names its scope and a widening");
    } finally {
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
