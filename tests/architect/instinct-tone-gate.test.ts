// INSTINCT TONE GATE (architect, 2026-11-10): the owner asked "does it respond concise like Instinct? does it have the exact
// same tone as Instinct?". This gate answers with numbers. It drives the turns docs/architect/INSTINCT-HEAD-TO-HEAD.md drives
// (A.2's audited turns and B.6 continuations 1-5) through the real handler (handler-career.ts on Postgres 16,
// tests/architect/helpers/response_world.ts), after the person pasted and confirmed the fictional TEST resume of
// h2h-fixes-20261110.test.ts, with the staged brain on a scripted model that answers each B.6 turn with Instinct's target (as
// that test does). Code-first turns never reach the model, so their reply is the router's own words on either path. Each
// Trainee reply is scored against Instinct's reply for the same turn: Instinct's style is the bar, never its wording.
//   length    the reply's prose (list items and bare link lines are the content asked for, as in the rubric's channel_length) is
//             at most 1.2 x Instinct's, or Instinct's + 40 characters for a very short one
//   internal  the rubric's `internal` rule plus the words the head-to-head saw: "the record", "packet" when the person did not
//             say it, "host", "write is not confirmed"
//   filler    the rubric's `boilerplate_tail`
//   refusal   the reply opens "I can't" / "I couldn't" / "I cannot" where Instinct's reply for that turn does the thing
//   answers   the rubric's `answers_first` (reported, not barred: two of Instinct's own targets break it)
// Bar: within_length N/N, internal 0, filler 0, refusals 0; the turns in OPEN below are the named exceptions to the length bar,
// asserted exactly, so one that starts passing must leave the list. A.2 search turn 2 is not scored: Instinct's reply there is its
// daily AI-answer limit, which Trainee does not have (D-046), so there is no like-for-like reply to compare.
import assertNode from "node:assert/strict";
import { answersFirst, boilerplateTails, internalWords } from "../../supabase/functions/_shared/reply_rubric.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { B6 } from "./helpers/b6_continuations.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

// The fictional TEST resume of h2h-fixes-20261110.test.ts (A.4's shape), unchanged.
const AVERY = `AVERY FIXTURE
Chicago, IL (Lincoln Park)

EDUCATION
TEST State University, B.A. Economics, May 2027
- GPA 3.8
- SAT 1520
- Involvement: TEST Investment Club

EXPERIENCE
AI M&A Intern, TEST Advisory, Jun 2025 - Aug 2025
- Screened AI software targets for two sell-side processes
- Drafted company profiles for 12 buyer outreach lists
- Updated comparable-company tables in Excel each week
Private Equity Intern, TEST Capital Partners, Jan 2025 - May 2025
- Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets
- Summarized diligence findings for three investment memos
- Tracked portfolio KPIs in a weekly Excel dashboard
Founder, TEST Tutoring Co, Jan 2022 - Dec 2023
- Ran a tutoring service for 30 high-school students
- Managed scheduling and billing for four tutors
- Grew revenue through word of mouth at two schools
Founder, TEST Resale Studio, Feb 2023 - Present
- Resell refurbished electronics through an online store
- Track inventory and margins in a shared spreadsheet
- Handle customer support for every order

ADDITIONAL
Cumulative GPA: 3.6 (registrar transcript)

SKILLS
Technical: Python, Excel
Certifications: TEST Bloomberg Market Concepts

INTERESTS
Golf, chess, Chicago architecture
`;

// A.2: the five audited turns, with Instinct's reply for each (INSTINCT-HEAD-TO-HEAD.md, "A.2: the five audited turns").
const A2 = [
  { id: "A2.R1", say: "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF.", target: "Here is the one-page PDF, ordered toward data analyst internships. It is built from your saved intake notes rather than the original resume file, so I left GPA off because the sources disagree and marked the contact details to fill in. I did not add experience; I reordered and tightened the supplied draft." },
  { id: "A2.R2", say: "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF. If a fact needs my confirmation, ask me the specific question rather than adding anything.", target: "I can make the data analyst internship draft from your saved resume notes. Before I finalize it, please confirm the conflicting GPA and the contact details you want included." },
  { id: "A2.R3", say: "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything.", target: "I used the wrong role. I will redo the draft for data analyst internships and will not apply anywhere." },
  { id: "A2.S1", say: "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.", target: "I will look for open Chicago data analyst internships and check the actual application pages. I will return up to five verified matches and will not apply." },
  { id: "A2.S2", say: "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.", target: "I hit the daily AI-answer limit, so I cannot finish this search right now. It resets at 6 pm Chicago time today; I have not applied anywhere.", notScored: "Instinct's reply is its daily AI-answer limit; Trainee has no per-person limit (D-046)" },
];
const [R1, , , S1, S2] = A2.map((t) => t.say);

// Turns still over the length bar, each with why (open work, not a pass). Only the length bar may be open.
const OPEN: Record<string, string> = {
  "A2.R3": "Instinct's reply (102 characters) answers neither the download-link ask nor re-sends the file (A.5 fails it on O); Trainee re-sends the PDF, says nothing was applied for and answers the link ask, which takes more than 142 characters",
  "C2.t3": "the empty-search reply (career_search_judge.ts, R01 empty-search scope and R05 remote-only) is being rewritten on branch ag/d054-fixes; left to that branch so the two do not collide",
};

// ------------------------------------------------------------------------------------------------------------- the scorer
export interface ToneTurn { id: string; ask: string; instinct: string; reply: string }
export interface ToneScore { id: string; chars: number; instinctChars: number; allowed: number; withinLength: boolean; internal: string[]; filler: string[]; refusal: boolean; answersFirst: boolean }

const isListLine = (l: string) => /^\s*(?:\d{1,2}[.)]|[-*•])\s/.test(l);
const isUrlLine = (l: string) => /^\s*(?:[-*•]\s*)?https?:\/\/\S+\s*$/.test(l);
// The prose of a reply: what the person reads as sentences. A numbered card (with its indented lines) or a bare link is the
// content asked for.
export function proseOf(s: string) {
  const out: string[] = [];
  let inItem = false;
  for (const l of String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (!l.trim()) { inItem = false; continue; }
    if (isListLine(l)) { inItem = true; continue; }
    if (inItem && /^\s{2,}\S/.test(l)) continue;
    inItem = false;
    if (!isUrlLine(l)) out.push(l.trim());
  }
  return out.join(" ");
}
export const allowedFor = (instinctChars: number) => Math.max(Math.round(instinctChars * 1.2), instinctChars + 40);
// Words the head-to-head saw that the rubric's `internal` rule does not hold yet.
const OBSERVED: [string, RegExp][] = [
  ["the record", /\bthe record\b/i],
  ["host", /\bhost\b/i],
  ["write is not confirmed", /\bwrite is not confirmed\b/i],
];
const REFUSAL = /^(?:i can['’]?t|i couldn['’]?t|i cannot|i could not|i'm unable|i am unable)\b/i;
const firstLine = (s: string) => String(s ?? "").trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";

export function scoreTone(t: ToneTurn): ToneScore {
  const chars = proseOf(t.reply).length, instinctChars = proseOf(t.instinct).length, allowed = allowedFor(instinctChars);
  const internal = [
    ...internalWords({ ask: t.ask, reply: t.reply }).map((v) => `${v.detail}: ${v.quote}`),
    ...OBSERVED.filter(([, rx]) => rx.test(t.reply)).map(([n]) => n),
    // "packet" is Trainee's word unless the person used it first.
    ...(/\bpackets?\b/i.test(t.reply) && !/\bpackets?\b/i.test(t.ask) ? ["packet"] : []),
  ];
  const filler = boilerplateTails({ ask: t.ask, reply: t.reply }).map((v) => `${v.detail}: ${v.quote}`);
  const refusal = REFUSAL.test(firstLine(t.reply)) && !REFUSAL.test(firstLine(t.instinct));
  return { id: t.id, chars, instinctChars, allowed, withinLength: chars <= allowed, internal: [...new Set(internal)], filler, refusal, answersFirst: !answersFirst({ ask: t.ask, reply: t.reply }).length };
}

export function toneLine(s: ToneScore[]) {
  const n = s.length, mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
  return `TONE-GATE turns=${n} within_length=${s.filter((x) => x.withinLength).length}/${n} internal=${s.filter((x) => x.internal.length).length} filler=${s.filter((x) => x.filler.length).length} refusals=${s.filter((x) => x.refusal).length} answers_first=${s.filter((x) => x.answersFirst).length}/${n} mean_chars=${mean(s.map((x) => x.chars))} vs instinct=${mean(s.map((x) => x.instinctChars))}`;
}

Deno.test("tone scorer: each rule on its own", () => {
  const ok = scoreTone({ id: "u", ask: "Find me five data analyst internships", instinct: "I will look for open roles and return up to five.", reply: "One data analyst internship is open.\n1. Data Analyst Intern at Lakefront\nhttps://example.test/a" });
  assertNode.ok(ok.withinLength && !ok.internal.length && !ok.filler.length && !ok.refusal && ok.answersFirst, JSON.stringify(ok));
  assertNode.equal(proseOf("Two found.\n1. A at B\n   Student window: not stated.\n2. C at D\nhttps://x.test/a\nWhich one?"), "Two found. Which one?");
  assertNode.equal(allowedFor(100), 140);
  assertNode.equal(allowedFor(300), 360);
  const long = scoreTone({ id: "u", ask: "x", instinct: "Here it is.", reply: "Here it is. ".repeat(10) });
  assertNode.ok(!long.withinLength);
  assertNode.deepStrictEqual(scoreTone({ id: "u", ask: "what is saved?", instinct: "Your GPA.", reply: "The record holds your GPA." }).internal, ["system words: The record", "the record"]);
  assertNode.ok(scoreTone({ id: "u", ask: "what next?", instinct: "Done.", reply: "The host record write is not confirmed." }).internal.includes("host"));
  assertNode.ok(scoreTone({ id: "u", ask: "apply", instinct: "Ready.", reply: "Your packet is ready." }).internal.includes("packet"));
  assertNode.deepStrictEqual(scoreTone({ id: "u", ask: "send me the packet", instinct: "Here.", reply: "There is no packet yet." }).internal, []);
  assertNode.ok(scoreTone({ id: "u", ask: "hi", instinct: "Hi.", reply: "Hi. Tell me what you'd like to do next." }).filler.length);
  assertNode.ok(scoreTone({ id: "u", ask: "shorter", instinct: "Proposed replacement: Built X.", reply: "I couldn't shorten it." }).refusal);
  assertNode.ok(!scoreTone({ id: "u", ask: "pick my answers", instinct: "I cannot choose your legal status.", reply: "I can't choose your work status." }).refusal, "Instinct declines too");
});

Deno.test({
  name: "tone gate: Trainee's replies against Instinct's on the head-to-head turns, through the real handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: tone gate handler part not run`); return; }
    const scriptedTurns = B6.flatMap((c) => c.turns);
    const scripted = (chat: any) => {
      const last = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
      const hit = scriptedTurns.filter((t) => last.includes(t.say)).sort((a, b) => b.say.length - a.say.length)[0];
      return Response.json({ id: "tone", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : hit?.target ?? "I can't answer that from this chat yet." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(8, { model: (req) => anthropicWire(req, scripted) });
    const turns: ToneTurn[] = [];
    try {
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const person = async (before: string[]) => {
        const p = await w.person();
        await p.say(AVERY);
        assertNode.match((await p.say("Yes, that's my resume")).reply, /10 facts/);
        for (const m of before) await p.say(m);
        return p;
      };
      const run = async (p: Awaited<ReturnType<typeof person>>, id: string, say: string, instinct: string, scored = true) => {
        const r = await p.say(say);
        assertNode.equal(r.status, 200, say);
        if (scored) turns.push({ id, ask: say, instinct, reply: String(r.reply ?? "") });
      };
      // A.2 as one conversation, as audited.
      const a = await person([]);
      for (const t of A2) await run(a, t.id, t.say, t.target, !t.notScored);
      // B.6 continuations in the contexts the head-to-head used.
      const before: Record<string, string[]> = { C1: [R1], C2: [], C3: [S1, S2], C4: [R1, S1, S2], C5: [] };
      for (const c of B6) {
        const p = await person(before[c.id] ?? []);
        for (const [k, t] of c.turns.entries()) await run(p, `${c.id}.t${k + 1}`, t.say, t.target);
      }
      assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
    const scores = turns.map(scoreTone);
    for (const [k, s] of scores.entries()) {
      const why = [!s.withinLength && `long ${s.chars}>${s.allowed}`, s.internal.length && `internal [${s.internal.join("; ")}]`, s.filler.length && `filler [${s.filler.join("; ")}]`, s.refusal && "needless refusal", !s.answersFirst && "not answer-first"].filter(Boolean);
      console.log(`TONE ${s.id.padEnd(6)} ${String(s.chars).padStart(4)}/${String(s.instinctChars).padStart(3)} ${why.length ? why.join(", ") : "ok"} | ${turns[k].reply.replace(/\s+/g, " ")}`);
    }
    const line = toneLine(scores);
    console.log(line);
    console.log(`(person's zone ${ZONE}; A.2 search turn 2 not scored: ${A2[4].notScored})`);
    const bad = scores.filter((s) => !s.withinLength || s.internal.length || s.filler.length || s.refusal);
    for (const s of bad) if (OPEN[s.id]) console.log(`TONE-OPEN ${s.id}: ${OPEN[s.id]}`);
    // The bar holds on every turn but the open ones; an open turn that now passes must leave OPEN (a ratchet, never a waiver).
    assertNode.deepStrictEqual(bad.map((s) => s.id), Object.keys(OPEN), line);
    for (const id of Object.keys(OPEN)) { const s = scores.find((x) => x.id === id)!; assertNode.ok(s.withinLength === false && !s.internal.length && !s.filler.length && !s.refusal, `${id} is open for length only`); }
  },
});
