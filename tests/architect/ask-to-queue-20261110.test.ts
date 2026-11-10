// ASK TO QUEUE (a-ask-to-queue, 2026-11-10; VERIFICATION-15 item 1, the first step; RESPONSE-RULES E1 and E2). After a
// numbered shortlist, the person's words name a set ("apply to the top three", "apply to 2 and 4", "apply to all of them"),
// and exactly that set is queued (career_apply_wanted), once. When the results message offers "Reply yes and I'll apply to
// all N shown", a bare yes approves exactly the prepared roles that message showed (career_apply_jobs, each bound to its own
// prepared payload hash), once; a yes after the list or a payload changed, after another turn, or after the offer went stale
// approves nothing of the old offer. Agent 2's app-layer loop (#674) covers prepare, the card and the card's yes.
//
// 56 scripts, one synthetic TEST person each, through the REAL agent-chat handler (handler-career.ts handleChat on tests/flow:
// real supabase-js over the PostgREST double, Postgres 16 with every migration), the staged brain released and a scripted $0
// model on the Anthropic wire. The expected set of each script is read from what the person was shown: the numbered lines of
// the last list in a reply (each line's link names its posting), resolved by the positions the person typed. E2: a number
// means the list LAST shown, until a new list is shown (a widened or new search), and an unrelated turn does not change it.
//
// Prints: ASK-TO-QUEUE: scripts S, exact E/S, queued rows R (expected X), approved rows A (expected Y), duplicates D,
// stale yes refused T/T, hash match H/A. Bar: every script exact, 0 duplicates, every stale yes refused, every approval
// bound to its prepared payload's hash. Nothing reaches an employer: nothing runs past the queue.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { payloadOf, RESUME_A } from "./scenarios-apply-r3-battery.ts";
import { nothingNewLine, widenedAsk } from "../../supabase/functions/_shared/search_widen.ts";

const CI = Deno.env.get("CI") === "true";
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };
// Eight open postings: five in Chicago, one in Evanston (outside "Chicago"), two remote in the US. Newest first is A, B, ...
const LOC = ["Chicago, IL", "Chicago, IL", "Remote - United States", "Chicago, IL", "Evanston, IL", "Chicago, IL", "Remote - United States", "Chicago, IL"];
const BOARD = LOC.map((loc, i) => ({ id: `greenhouse:atq${i}:${301 + i}`, co: `TEST Queue ${String.fromCharCode(65 + i)}`, t: "Data Analyst Intern", loc,
  url: `https://boards.greenhouse.io/atq${i}/jobs/${301 + i}`, d: loc.startsWith("Remote") ? "Fully remote. SQL." : "Hybrid, three days a week. SQL and Python." }));
const BY_URL = new Map(BOARD.map((b) => [b.url, b.id]));
const BY_IDX = (jobId: string) => BOARD.findIndex((b) => b.id === jobId);
const SEARCH = "Find me data analyst internships in Chicago.";
const WIDEN = "include remote US internships too";
const REMOTE = "Find me remote data analyst internships in the US.";
const ENVK: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "TEST-ask-to-queue-link-secret-0123456789abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };

// A step: what the person types, and what it names. `queue`: positions on the list last shown that this turn queues;
// `approve`: positions on the list last shown that this yes approves (only those prepared); `stale`: this yes must
// approve nothing of the earlier offer it is not an answer to. `then`: a change in the world after the turn.
type Pos = number[] | "all";
interface Ctx { u: string; lists: string[][]; prepare: (jobIdx: number) => Promise<void>; sql: (q: string) => Promise<string> }
// `listed`: the reply lists exactly this many roles; `kept`: the reply shows no new list, so the list last shown stands;
// `has` / `never`: what the reply must say, and must never say.
interface Step { say: string; queue?: Pos; approve?: Pos; stale?: true; concurrent?: true; then?: (s: Ctx) => Promise<void>; listed?: number; kept?: true; has?: RegExp; never?: RegExp }
interface Script { name: string; prepared?: number[] | "all"; noResume?: true; steps: Step[] }
const R = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ASK = (say: string, queue: Pos): Script => ({ name: say, steps: [{ say: SEARCH }, { say, queue }] });
// A widening is never read as a role made of its cue words ("include too", "add as well"), and never a fresh search.
const NOT_A_ROLE = /\b(?:include|add|plus|also)\b[^.\n]{0,20}\b(?:too|as well)\b internships|I checked (?:include|add|also|plus)\b/i;
const OTHER = "what should my cover letter say?";
// A turn the router answers that is not a search (a list reference): it ends the search a correction could amend (spec 2.3).
const REF = "tell me more about the second one";
// An offer to send a resume, made to someone whose confirmed resume is on their account (coordinator, 2026-11-10).
const RESUME_ASK = /send (?:me )?your resume|paste your resume|I need your resume first|Want to send it now|Want to start with your resume/i;

export const SCRIPTS: Script[] = [
  // ---- ask to queue, one ask after the shortlist (5 listed)
  ASK("apply to the top three", [1, 2, 3]),
  ASK("apply to the top 2", [1, 2]),
  ASK("apply to the top three from that list", [1, 2, 3]),
  ASK("apply to 2 and 4", [2, 4]),
  ASK("apply to 1, 3 and 5", [1, 3, 5]),
  ASK("apply to all of them", "all"),
  ASK("apply to these", "all"),
  ASK("apply to the second one", [2]),
  ASK("apply to #4", [4]),
  ASK("apply to the first and third", [1, 3]),
  ASK("apply to 3 of them", [1, 2, 3]),
  ASK("apply to the top 10", "all"),
  ASK("apply to 2 and 9", [2]),
  ASK("apply to 3", [3]),
  ASK("apply to number 5", [5]),
  ASK("apply to the 2nd and 4th", [2, 4]),
  ASK("apply to the top three please", [1, 2, 3]),
  ASK("apply to 9", []),
  // ---- duplicates and overlaps: each posting queued once
  { name: "the same ask twice", steps: [{ say: SEARCH }, { say: "apply to the top three", queue: [1, 2, 3] }, { say: "apply to the top three", queue: [] }] },
  { name: "overlapping asks", steps: [{ say: SEARCH }, { say: "apply to 2 and 4", queue: [2, 4] }, { say: "apply to 4 and 5", queue: [5] }] },
  // ---- E2: numbered references after a constraint change mean the list last shown
  { name: "E2 an unrelated turn keeps the list", steps: [{ say: SEARCH }, { say: "what should my cover letter say?" }, { say: "apply to 2 and 4", queue: [2, 4] }] },
  { name: "E2 widened: 2 and 4 of the new list", steps: [{ say: SEARCH }, { say: WIDEN }, { say: "apply to 2 and 4", queue: [2, 4] }] },
  { name: "E2 widened: the top three of the new list", steps: [{ say: SEARCH }, { say: WIDEN }, { say: "apply to the top three", queue: [1, 2, 3] }] },
  { name: "E2 one before, one after the widening", steps: [{ say: SEARCH }, { say: "apply to 3", queue: [3] }, { say: WIDEN }, { say: "apply to 3", queue: [3] }] },
  { name: "E2 a new search: its own numbers", steps: [{ say: SEARCH }, { say: REMOTE }, { say: "apply to 1 and 2", queue: [1, 2] }] },
  { name: "E2 widened: all of them", steps: [{ say: SEARCH }, { say: WIDEN }, { say: "apply to all of them", queue: "all" }] },
  // ---- E1: one yes approves exactly the set the offer showed
  { name: "E1 yes approves the 5 shown", prepared: "all", steps: [{ say: SEARCH }, { say: "yes", approve: "all" }] },
  { name: "E1 'yes please'", prepared: "all", steps: [{ say: SEARCH }, { say: "yes please", approve: "all" }] },
  { name: "E1 'apply to all of them' answers the offer", prepared: "all", steps: [{ say: SEARCH }, { say: "apply to all of them", approve: "all" }] },
  { name: "E1 three prepared: those approved, the other two queued to prepare", prepared: [0, 1, 3], steps: [{ say: SEARCH }, { say: "yes", approve: "all", queue: [4, 5] }] },
  { name: "E1 after a widening: the 7 the widened list showed", prepared: "all", steps: [{ say: SEARCH }, { say: WIDEN }, { say: "yes", approve: "all" }] },
  { name: "E1 'yes but not the second one' approves nothing", prepared: "all", steps: [{ say: SEARCH }, { say: "yes but not the second one", approve: [] }] },
  // ---- duplicate yeses: each approval once
  { name: "yes, then yes again", prepared: "all", steps: [{ say: SEARCH }, { say: "yes", approve: "all" }, { say: "yes", approve: [] }] },
  { name: "two yeses at once", prepared: "all", steps: [{ say: SEARCH }, { say: "yes", approve: "all", concurrent: true }] },
  { name: "yes, then 'apply to all of them'", prepared: "all", steps: [{ say: SEARCH }, { say: "yes", approve: "all" }, { say: "apply to all of them", approve: [], queue: [] }] },
  // ---- a yes after the list changed: nothing of the old offer
  { name: "stale: a new search replaced the list; yes approves only the new list", prepared: "all", steps: [{ say: SEARCH }, { say: REMOTE }, { say: "yes", approve: "all", stale: true }] },
  { name: "stale: a payload changed after the offer; that one is refused", prepared: "all",
    steps: [{ say: SEARCH, then: async (s) => { const l = s.lists.at(-1); if (l?.[1]) await s.prepare(BY_IDX(l[1])); } }, { say: "yes", approve: [1, 3, 4, 5], stale: true }] },
  { name: "stale: the offer is older than the yes window", prepared: "all",
    steps: [{ say: SEARCH, then: async (s) => { await s.sql(`update public.agent_messages set meta = jsonb_set(meta, '{apply_all_offer,at}', to_jsonb(((meta->'apply_all_offer'->>'at')::bigint - 11 * 60000))) where thread_id in (select id from public.agent_threads where user_id = '${s.u}') and meta ? 'apply_all_offer'`); } },
      { say: "yes", approve: [], stale: true }] },
  { name: "stale: another turn came between the offer and the yes", prepared: "all", steps: [{ say: SEARCH }, { say: "what should my cover letter say?" }, { say: "yes", approve: [], stale: true }] },
  { name: "stale: an apply ask came between the offer and the yes", prepared: "all", steps: [{ say: SEARCH }, { say: "apply to 2 and 4", queue: [2, 4] }, { say: "yes", approve: [], stale: true }] },
  // ---- 41-50: a widening after a turn that was not a search widens the last real search (coordinator, 2026-11-10)
  { name: "widen after a list reference, then 2 and 4 of the widened list", steps: [{ say: SEARCH }, { say: REF }, { say: WIDEN, listed: 7, never: NOT_A_ROLE }, { say: "apply to 2 and 4", queue: [2, 4] }] },
  { name: "widen after an apply ask", steps: [{ say: SEARCH }, { say: "apply to 1", queue: [1] }, { say: "also add remote US internships", listed: 7, never: NOT_A_ROLE }, { say: "apply to 3", queue: [3] }] },
  { name: "'plus remote roles in the US' after a list reference", steps: [{ say: SEARCH }, { say: REF }, { say: "plus remote roles in the US", listed: 7, never: NOT_A_ROLE }, { say: "apply to the top three", queue: [1, 2, 3] }] },
  { name: "a list reference and an unrelated turn, then the widening", steps: [{ say: SEARCH }, { say: REF }, { say: OTHER }, { say: WIDEN, listed: 7, never: NOT_A_ROLE }, { say: "apply to 6 and 7", queue: [6, 7] }] },
  { name: "'add remote internships in the US as well', then all of them", steps: [{ say: SEARCH }, { say: OTHER }, { say: "add remote internships in the US as well", listed: 7, never: NOT_A_ROLE }, { say: "apply to all of them", queue: "all" }] },
  { name: "a widening that finds nothing new keeps the list and says so", steps: [{ say: SEARCH }, { say: REF }, { say: "include business analyst internships too", kept: true, never: NOT_A_ROLE, has: /nothing new|no new/i }, { say: "apply to 5", queue: [5] }] },
  { name: "nothing new after a real widening keeps the widened list", steps: [{ say: SEARCH }, { say: OTHER }, { say: WIDEN, listed: 7 }, { say: "include business analyst internships too", kept: true, never: NOT_A_ROLE, has: /nothing new|no new/i }, { say: "apply to 7", queue: [7] }] },
  { name: "a widening of an empty search names its scope, never 'include too'", steps: [{ say: "Find me economist internships in Peoria." }, { say: "thanks" }, { say: WIDEN, never: NOT_A_ROLE, has: /economist/i }] },
  { name: "widen after a list reference, then a number past the end", steps: [{ say: SEARCH }, { say: REF }, { say: WIDEN, listed: 7, never: NOT_A_ROLE }, { say: "apply to 9", queue: [] }, { say: "apply to 2 and 9", queue: [2] }] },
  // Every listed role closes on its board before the widening, so it finds nothing at all: the list shown still stands.
  { name: "a widening that finds nothing at all never wipes the list shown", steps: [
    { say: SEARCH, then: (s) => s.sql(`update public.career_postings set closed_at = now() where job_id in (${s.lists.at(-1)!.map(lit).join(", ")})`).then(() => {}) },
    { say: REF },
    { say: "include business analyst internships too", kept: true, never: NOT_A_ROLE, has: /nothing new/i, then: (s) => s.sql(`update public.career_postings set closed_at = null`).then(() => {}) },
    { say: "apply to 2 and 3", queue: [2, 3] }] },
  // ---- 51-56: a confirmed resume on the person's account is on record; nobody who has one is asked to send it
  { name: "a list reference never asks for the resume on file", steps: [{ say: SEARCH }, { say: REF, never: RESUME_ASK, has: /TEST Queue B/ }] },
  { name: "'show me the first one' never asks for it", steps: [{ say: SEARCH }, { say: "show me the first one", never: RESUME_ASK, has: /TEST Queue A/ }] },
  { name: "'show me more' never asks for it", steps: [{ say: SEARCH }, { say: "show me more", never: RESUME_ASK }] },
  { name: "an introduction never asks for it", steps: [{ say: "my name is TEST Avery", never: RESUME_ASK }] },
  { name: "/start never asks for it", steps: [{ say: "/start", never: RESUME_ASK }] },
  // Control: with no resume anywhere, the same list reference does offer to take one (the check above can fail).
  { name: "control: no resume on file, the list reference asks for it", noResume: true, steps: [{ say: SEARCH }, { say: REF, has: RESUME_ASK }] },
];

// The postings a reply listed, in its order: each numbered line's link names its posting.
export function listedIn(reply: string): string[] {
  const out: string[] = [];
  for (const line of reply.split("\n")) {
    const n = /^(\d+)\. /.exec(line), url = (line.match(/https:\/\/[^\s)]+/g) ?? []).map((x) => x.replace(/[.,]+$/, "")).find((x) => BY_URL.has(x));
    if (n && url && Number(n[1]) === out.length + 1) out.push(BY_URL.get(url)!);
  }
  return out;
}
const at = (list: string[], p: Pos) => p === "all" ? list.slice() : p.filter((i) => i >= 1 && i <= list.length).map((i) => list[i - 1]);

Deno.test("ask-to-queue self-check: the list is read from the reply's numbered lines, and positions resolve against it", () => {
  const reply = `Intro.\n1. Data Analyst Intern at TEST Queue A — Chicago, IL, hybrid (${BOARD[0].url}).\n   Checked: not re-checked.\n2. Data Analyst Intern at TEST Queue D — Chicago, IL (${BOARD[3].url}).\nSay "apply to these".`;
  assertNode.deepEqual(listedIn(reply), [BOARD[0].id, BOARD[3].id]);
  assertNode.deepEqual(at(listedIn(reply), [2, 9]), [BOARD[3].id]);
  assertNode.deepEqual(listedIn(`1. TEST Queue A — Data Analyst Intern, Chicago, IL (not re-checked) ${BOARD[0].url}\n2. TEST Queue C — Data Analyst Intern (not re-checked) ${BOARD[2].url}`), [BOARD[0].id, BOARD[2].id], "the iMessage form");
  assertNode.equal(SCRIPTS.length, 56);
  assertNode.ok(NOT_A_ROLE.test("I checked include too internships in Chicago") && !NOT_A_ROLE.test("I found 7 data analyst internships in Chicago and remote in the US"));
});

Deno.test("widening units: the last real search is widened after a turn that cleared it; nothing new is said, with what was added", () => {
  const ask = { role: "data analyst", place: "chicago", remote: false, limits: { bands: ["intern" as const], pay: null, company: null, term: null, needsSponsor: false } };
  const cleared = { lastAsk: null, lastAskAt: null, lastSearch: { ask, at: 1000 }, lastShortlist: [{ id: "a" }, { id: "b" }] };
  const w = widenedAsk(WIDEN, cleared, 2000)!;
  assertNode.deepEqual([w.ask.role, w.ask.place, w.ask.remote, w.ask.remoteRegion, w.ask.keep], ["data analyst", "chicago", true, "us", ["a", "b"]]);
  assertNode.deepEqual(w.added, ["remote roles in the US"]);
  assertNode.equal(widenedAsk(WIDEN, cleared, 1000 + 31 * 60_000), null, "an old search is not widened");
  assertNode.equal(widenedAsk(WIDEN, { lastAsk: null, lastAskAt: null }, 2000), null, "no search to widen: not a widening");
  assertNode.deepEqual(widenedAsk("include business analyst internships too", { lastAsk: ask, lastAskAt: 1000 }, 2000)!.added, ["business analyst"]);
  assertNode.equal(nothingNewLine(["business analyst"], ["a", "b"], ["a", "b"]), "Widening to include business analyst found nothing new: no other open role matched, so the 2 I listed before stand, under the same numbers.");
  assertNode.ok(nothingNewLine(["business analyst"], ["a", "b"], []), "found nothing at all: said too");
  assertNode.equal(nothingNewLine(["remote roles in the US"], ["a"], ["a", "c"]), null, "something new: not said");
  assertNode.equal(nothingNewLine(["remote roles in the US"], [], []), null, "no list before: the search's own empty reply speaks");
});

Deno.test({
  name: "ask to queue: 56 scripts through the real handler on Postgres 16; exactly the named set queued or approved, once; a stale yes refused",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "MODEL_BUDGET_PAUSED",
      "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL", "CAREER_APPLY_ALL_YES", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", ...Object.keys(ENVK)];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error, realLog = console.log;
    const people = SCRIPTS.map((_, i) => `7b0f8f8e-6a43-4a49-9d2c-0000000c${String(i + 1).padStart(4, "0")}`);
    try {
      await supabaseParity(pg);
      const sql = (q: string) => pg.sql(q);
      await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values
        ${BOARD.map((b, i) => `(${lit(b.id)}, 'greenhouse', ${lit(b.id.split(":")[1])}, ${lit(b.co)}, ${lit(b.t)}, ${lit(b.loc)}, ${lit(b.url)}, ${lit(b.d)}, now() - interval '${i + 1} hours', now() - interval '${i + 1} hours', now())`).join(",\n")};`);
      for (const [i, u] of people.entries()) {
        await sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id) values ('${u}');
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${SCRIPTS[i].noResume ? "" : `${confirmedResumeSql(u, RESUME_A)}
          insert into public.career_resume_devices (user_id, sha256, at) values ('${u}', encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex'), now());`}`);
      }
      const sha = (await sql(`select encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex')`)).trim();
      let ver = 0;
      const prepareFor = (u: string) => async (idx: number) => {
        const p = BOARD[idx];
        // deno-lint-ignore no-explicit-any
        const payload: any = payloadOf({ spec: { company: p.co }, jobId: p.id, url: p.url } as any, { expiresIn: 3600_000, stamp: "current", fields: [], quarantine: "current" } as any, ++ver, { epoch: 0, version: 0, authority: 0 }, Date.now(), u, sha);
        await sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.id)} and state in ('ready','shown');
          insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
          select '${u}', ${lit(p.id)}, ${lit(p.co)}, ${lit(p.url)}, x.p, public.career_apply_payload_hash(x.p), array[${lit(p.co)}]::text[], 'ready' from (select ${lit(JSON.stringify(payload))}::jsonb as p) x`);
      };
      h = await careerHandler(pg, Object.fromEntries(people.map((u, i) => [`atq-${i}`, u])));
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as string, init);
        const u = new URL(req.url);
        // deno-lint-ignore no-explicit-any
        if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "A model reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } }));
        if (u.host === "boards-api.greenhouse.io") return Response.json({ id: Number(u.pathname.split("/").at(-1)) });
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].startsWith("{\"evt\"")) return; realLog(...a); };
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      for (const [k, v] of Object.entries(ENVK)) Deno.env.set(k, v);
      const rows = async (table: string, u: string, col: string, where = "") => (await sql(`select coalesce(string_agg(${col}, E'\\n' order by ${col}), '') from public.${table} where user_id = '${u}' ${where}`)).split("\n").filter(Boolean);
      const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
      const sum = { scripts: 0, exact: 0, queued: 0, queuedWant: 0, approved: 0, approvedWant: 0, dup: 0, staleTried: 0, staleRefused: 0, hashOk: 0 };
      const fails: string[] = [];
      for (const [i, sc] of SCRIPTS.entries()) {
        const u = people[i], chat = h.chat(`atq-${i}`);
        const s: Ctx = { u, lists: [], prepare: prepareFor(u), sql };
        if (sc.prepared) for (const idx of sc.prepared === "all" ? R(0, BOARD.length - 1) : sc.prepared) await s.prepare(idx);
        const wantQ = new Set<string>(), wantA = new Set<string>(), staleOld = new Set<string>(), transcript: string[] = [], said: string[] = [];
        let stale = false;
        for (const st of sc.steps) {
          await sql(`delete from public.agent_rate_limits`);
          const shown = s.lists.at(-1) ?? [];
          const before = s.lists.length >= 2 ? s.lists.at(-2)! : [];
          const preparedNow = new Set(await rows("career_apply_prepared", u, "job_id", "and state in ('ready','shown')"));
          const say = () => chat.say(st.say, { channel: "imessage" });
          const r = st.concurrent ? (await Promise.all([say(), say()]))[0] : await say();
          transcript.push(`> ${st.say}\n[${r.intent}] ${r.reply.slice(0, 700)}`);
          const listed = listedIn(r.reply);
          if (st.listed !== undefined && listed.length !== st.listed) said.push(`"${st.say}" listed ${listed.length}, not ${st.listed}`);
          if (st.kept && listed.length && JSON.stringify(listed) !== JSON.stringify(shown)) said.push(`"${st.say}" replaced the list shown`);
          if (st.has && !st.has.test(r.reply)) said.push(`"${st.say}" does not say ${st.has}`);
          if (st.never && st.never.test(r.reply)) said.push(`"${st.say}" says ${st.never}`);
          if (listed.length) s.lists.push(listed);
          if (st.queue) for (const j of at(shown, st.queue)) wantQ.add(j);
          if (st.approve) for (const j of at(shown, st.approve)) if (preparedNow.has(j)) wantA.add(j);
          // A stale yes: nothing it was not an answer to is approved (the old list's roles, the changed payload, the stale offer).
          if (st.stale) { stale = true; for (const j of [...before, ...shown]) if (!wantA.has(j)) staleOld.add(j); }
          await st.then?.(s);
        }
        const queued = await rows("career_apply_wanted", u, "posting_key"), approved = await rows("career_apply_jobs", u, "job_id");
        const qSet = new Set(queued), aSet = new Set(approved);
        const dup = (queued.length - qSet.size) + (approved.length - aSet.size);
        const ok = same(qSet, wantQ) && same(aSet, wantA) && dup === 0 && !said.length;
        const hashOk = Number(await sql(`select count(distinct j.id) from public.career_apply_jobs j join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id
          and p.payload_hash = j.payload_hash and p.state <> 'expired' where j.user_id = '${u}'`));
        sum.scripts++; if (ok) sum.exact++;
        sum.queued += queued.length; sum.queuedWant += wantQ.size; sum.approved += approved.length; sum.approvedWant += wantA.size; sum.dup += dup; sum.hashOk += hashOk;
        if (stale) { sum.staleTried++; if (![...staleOld].some((j) => aSet.has(j))) sum.staleRefused++; }
        if (!ok) fails.push(`[${i + 1}] ${sc.name}: queued ${JSON.stringify(queued)} want ${JSON.stringify([...wantQ])}; approved ${JSON.stringify(approved)} want ${JSON.stringify([...wantA])}; dup ${dup}${said.length ? `; ${said.join("; ")}` : ""}\n${transcript.join("\n")}`);
      }
      for (const f of fails) realLog(`--- MISMATCH ${f}`);
      const line = `ASK-TO-QUEUE: scripts ${sum.scripts}, exact ${sum.exact}/${sum.scripts}, queued rows ${sum.queued} (expected ${sum.queuedWant}), approved rows ${sum.approved} (expected ${sum.approvedWant}), ` +
        `duplicates ${sum.dup}, stale yes refused ${sum.staleRefused}/${sum.staleTried}, hash match ${sum.hashOk}/${sum.approved}`;
      realLog(line);
      assertNode.deepEqual(outbound, [], "no request left but the fake boards");
      // Nothing was driven or sent. Script 50 closes the shared postings for a moment, and the queue rightly ends the other
      // people's approved jobs for them as not submitted (posting closed): that is the only state allowed past "queued".
      assertNode.equal(await sql(`select count(*) from public.career_apply_jobs where state <> 'queued' and not (state = 'not_submitted' and evidence->>'closed' = 'posting_closed')`), "0",
        `nothing ran past the queue: ${await sql(`select string_agg(distinct state || ' ' || left(evidence::text, 200), ' | ') from public.career_apply_jobs where state <> 'queued'`)}`);
      assertNode.ok(sum.exact === sum.scripts && sum.dup === 0 && sum.staleRefused === sum.staleTried && sum.hashOk === sum.approved, line);
    } finally {
      console.error = realError;
      console.log = realLog;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
