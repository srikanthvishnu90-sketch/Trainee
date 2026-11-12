// D-067 (architect, 2026-11-12): the fixes for live round 2 (live-6 on trunk 6e17f371: 1/26 turns matched Instinct; real model,
// production flags; evals/mirror/instinct-wa-batch1/results/live-6/). Each test reproduces the observed failure at $0 with a
// scripted model returning the shape live-6 recorded, and names the ruling it serves (P3). No network, no spend, nothing sent.
//   D67-1  C9 (D-024): an empty reply is never sent: a file-format research reply with no sentence on record falls back to the
//          brief's thesis; the last line of every brain turn turns a blank reply into the research's points or an honest line.
//   D67-2  C5f2 (G3/G12): the shortener's refusal ("no text to rewrite ... paste it") is never accepted: the shorter text must be a
//          rewrite of the reply; a practice session's code review is never shortened.
//   D67-3  C13 (D-007/G10): a draft never claims a prior exchange not on record ("thanks again for walking me through ...").
//   D67-4  C20 (D-007/G11): an edited entry is condensed, never reported dropped; a number never said to be the person's ask
//          unless they typed it.
//   D67-5  C8 (G2): an internal fact id (F-002) never reaches the person.
//   D67-6  C1 (G4): a posting's pay stated per place keeps its place: Chicago's range for a Chicago posting, never San Jose's.
//   D67-7  C1 (G1/G11): no record write offered on a pure question; a plan ask gets its plan File.
//   D67-8  G3 (live-6 median 705): the length pass runs on a turn whose tools only read (it never did), and accepts a faithful
//          shorter version of live-6's own long replies.
//   D67-9  C6 (G14): an ask about their own applications reads read_application_mail before it is answered.
//   D67-10 C22 (G7): pay this conversation already showed is used, with its source link; a named posting is read before research.
//   D67-11 (owner, must-fix (e)): every File link a reply carries opens through the real File server (200) and holds what the reply
//          says; a reply never says a page was made or attached unless a call this turn made one.
//   deno test -A --no-check tests/architect/d067-live-round2-20261112.test.ts
import assertNode from "node:assert/strict";
import { agentTurn, carriesCode, condensable, nonEmptyReply, payWithSource, processCheck, sameContent, SAYS_NOT_APPLIED, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { EMPTY_AFTER_SAVE_REPLY, EMPTY_REPLY, unbackedClaims } from "../../supabase/functions/_shared/agent/loop.ts";
import { capabilityTools } from "../../supabase/functions/_shared/agent/capability_tools.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";
import { enforceMarketReply, type MarketResult } from "../../supabase/functions/_shared/agent/research/market.ts";
import { checkFollowup } from "../../supabase/functions/_shared/followup_draft.ts";
import { leakedWords, misquotedAsks, stripLeaks } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { paysByPlace, placedPay } from "../../supabase/functions/_shared/posting_pay.ts";
import { searchPostings } from "../../supabase/functions/_shared/career_search.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { historyAskOf, overLimit, replyLength, shownPayOf, statesNothing, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { NO_SOURCES } from "../../supabase/functions/_shared/research_reply.ts";
import { POSTINGS } from "../../evals/mirror/instinct-wa-batch1/world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
// live-6's own replies (the transcript the run recorded, copied byte for byte from PR #783's
// evals/mirror/instinct-wa-batch1/results/live-6/trainee-live-6.jsonl), used as the brain's observed output.
const LIVE6: Record<string, string> = Object.fromEntries(Deno.readTextFileSync(new URL("../fixtures/mirror-live6/trainee-live-6.jsonl", import.meta.url)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).map((t: any) => [t.id, t.reply]));
const NOW = Date.parse("2026-11-12T03:00:00Z");
const FACTS = [
  { id: "F-001", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" },
  { id: "F-002", kind: "other", text: "GPA: 3.9", status: "confirmed" },
];
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
type Payload = { system: string; messages: any[]; tools: any[] };
function scripted(brain: (p: Payload, n: number) => any, plain: (p: Payload) => string = () => "") {
  const seen: Payload[] = [];
  let n = 0;
  const model = async (p: any) => { seen.push(p); return p.tools?.length ? brain(p, n++) : text(plain(p)); };
  return { model, seen };
}
const turn = (message: string, model: any, extra: Record<string, unknown> = {}) =>
  agentTurn({ message, history: [], stores: { profile: { facts: structuredClone(FACTS) } }, userId: "u-d067", threadId: "th-d067", now: NOW, model, ...extra } as any);
const readTool = (name: string, out: unknown) => ({ name, effect: "read", description: `${name} (test)`, input_schema: { type: "object", properties: {} }, run: async () => out });

// A synthetic market result in live-6 C9's shape: format "file", a thesis, every point cited to an anecdote source.
const C9_FILE: MarketResult = {
  status: "ok", format: "file", asked: "file", title: "Citadel new grad SWE", thesis: "Citadel's new grad SWE process runs several rounds and its culture is demanding.",
  points: [{ text: "Engineers there describe demanding hours.", cite: [1] }], conditions: [{ text: "Hours vary by team.", cite: [1] }], risks: [{ text: "Pressure is high.", cite: [1] }],
  comparison: null, sources: [{ n: 1, url: "https://www.reddit.com/r/quant/comments/x/citadel", title: "Citadel WLB", fetched_at: new Date(NOW).toISOString(), kind: "anecdote" } as any],
  file_url: "https://trainee.example/file?t=v1.brief1", dropped: 0, notes: [], searched: "test", note: "",
};

Deno.test("D67-1 C9 (D-024): a file research reply with no sentence on record is its thesis; a blank brain reply is never sent", () => {
  // The model's sentence has a figure no kept point holds: before D-067 this returned "" (live-6 C9: an empty message).
  const r = enforceMarketReply("Citadel pays $400k to every new grad.", C9_FILE);
  eq(r, C9_FILE.thesis, "the thesis, which code kept, stands for the brief; the File link follows it from code");
  ok(/[A-Za-z]/.test(enforceMarketReply("", { ...C9_FILE, thesis: null } as MarketResult)), "never empty, even with no thesis");
  // The last line of the reply path, for every brain turn.
  eq(nonEmptyReply({ reply: "  \n ", tool_calls: [] } as any), EMPTY_REPLY);
  eq(nonEmptyReply({ reply: "", tool_calls: [{ name: "add_profile_fact", ok: true, effect: "write_own" }] } as any), EMPTY_AFTER_SAVE_REPLY, "a turn that saved says so");
  eq(nonEmptyReply({ reply: "", show: { intent: "x", text: "Shown card." }, tool_calls: [] } as any), "Shown card.");
  eq(nonEmptyReply({ reply: "", tool_calls: [] } as any, C9_FILE), C9_FILE.thesis, "a research result with sources gives what it found");
  eq(nonEmptyReply({ reply: "Answer.", tool_calls: [] } as any), "Answer.", "a reply with words stands as written");
  ok(/Nothing was sent or submitted/.test(EMPTY_REPLY) && /couldn't finish/.test(EMPTY_REPLY), "honest: it did not finish, nothing was sent");
  // The handler applies the same guard after the people-search enforcement (its last edit of the reply).
  const handler = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  ok(/turn\.reply = nonEmptyReply\(turn\);/.test(handler), "handler-career.ts guards the brain's reply");
});

Deno.test("D67-2 C5f2 (G3/G12): the shortener's refusal is never the reply; a code review is never shortened", async () => {
  const review = "Your code returns 5 for the example, but on an empty list or one where every number repeats, next() raises StopIteration instead of returning None. " +
    "Pass a default: next((n for n in nums if counts[n] == 1), None). The list comprehension builds an unused list of None values just to call update; use a plain counting loop instead. " +
    "Time and space are both O(n). Follow-up: how would you adapt it if the input were a generator you can read only once?";
  const refusal = LIVE6.C5f2;
  ok(/no text to rewrite/.test(refusal), "live-6's own refusal text");
  ok(!shortenedOk(review, refusal, 2000), "a meta-reply is not a rewrite of the reply");
  ok(!sameContent(review, refusal.replace(/^It looks like.*?short text\. /, "")), "nor is a reply about something else, even without the meta words");
  ok(sameContent("I'd compare what each salary buys before treating the higher number as the winner, and check each offer's written benefits.", "Compare what each salary buys and the written benefits before treating the higher number as the winner."), "a faithful rewording is");
  // The turn: the person pasted code; the brain's review is long; the shortener is never called and the review stands.
  ok(carriesCode(P.C5f2) && carriesCode(review));
  const s = scripted(() => text(review), () => refusal);
  const r = await turn(P.C5f2, s.model);
  eq(r.reply, review);
  eq(s.seen.filter((p) => !p.tools?.length).length, 0, "no shortening pass on a code review");
});

Deno.test("D67-3 C13 (D-007/G10): a draft to a recruiter never thanks them for a call that is not on record", () => {
  const said = ["C1", "C2", "C3", "C4", "C5", "C6", "C5f1", "C5f2", "C7", "C8", "C9", "C10", "C11", "C12", "C13"].map((id) => P[id]).join("\n");
  const i = (body: string) => ({ kind: "note" as const, recipient: null, recipient_options: [], document: null, documents: [], body, tone: "casual" });
  const facts = ["Lakeshore University, BS Computer Science and Finance, Expected June 2029", "Sam Rivera"];
  const live = LIVE6.C13.replace(/^Draft, not sent:\s*/, ""); // live-6 ran before D-067 put the label after the draft
  ok(/thanks again for walking me through/.test(live), "live-6's draft");
  const bad = checkFollowup(i(live), { said, facts });
  ok(bad.status === "rewrite" && bad.problems.some((p) => /states a meeting or conversation/.test(p)), JSON.stringify(bad));
  for (const b of ["Hi [Name], it was great to connect last week. Is the comp range flexible?", "Hi [Name], thanks for explaining the role. Is the comp range flexible?", "Hi [Name], enjoyed our chat. Is the comp range set?"]) {
    const x = checkFollowup(i(b), { said, facts });
    ok(x.status === "rewrite" && x.problems.some((p) => /meeting or conversation/.test(p)), `${b}: ${JSON.stringify(x)}`);
  }
  const clean = checkFollowup(i("Hi [Name], quick question about the [role] at [company]: is the comp range flexible at all, or pretty set? Thanks, Sam"), { said, facts });
  eq(clean.status, "ok", JSON.stringify(clean));
  // A call the person did have, in their words, still licenses the thank-you.
  const had = checkFollowup(i("Hi [Name], thanks again for walking me through the role on our call."), { said: said + "\nI had a call with the recruiter yesterday, draft a thank-you", facts });
  eq(had.status, "ok", JSON.stringify(had));
});

Deno.test("D67-4 C20 (D-007/G11): a condensed entry keeps its role; no number is said to be the person's ask unless they typed it", async () => {
  // The tailored version from the benchmark's own PayPal posting, edited as live-6's brain asked (Waypoint to 6 lines).
  const ctx: any = { now: NOW, thread: {} };
  for (const s of JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR))).setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  const p = POSTINGS[0];
  const r: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001167", profile: ctx.profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true, edits: [{ role: "pixelforge", lines: 1 }, { role: "waypoint", lines: 6 }] });
  ok(r.ok, JSON.stringify(r).slice(0, 300));
  const pix = r.edits.find((e: any) => e.role === "pixelforge");
  eq([pix.change, pix.now], ["condensed", 1]);
  ok(JSON.stringify(r.detail.doc.lines).includes("Pixelforge, Founder (2023-2025)"), "Pixelforge still prints, with its role");
  ok(!r.changes.some((c: any) => c.kind === "drop" && /^Pixelforge/.test(c.line)), `never reported dropped: ${JSON.stringify(r.changes.slice(0, 3))}`);
  ok(r.changes.some((c: any) => c.kind === "edit" && /Pixelforge.*condensed to 1 detail line/.test(c.text)));
  ok(!/6 asked/.test(r.changelog), r.changelog);
  // Owner, must-fix (a): no role ever disappears from an edited version. Every confirmed entry of the record prints in it, the
  // ones the first pass left out for this posting included (live-6's v2 printed 3 of 9 entries).
  const printed = new Set(r.detail.doc.lines.flatMap((l: any) => l.factIds || []).map(String));
  const entries = ctx.profile.facts.filter((f: any) => ["experience", "project", "education", "leadership", "certification"].includes(f.kind) && f.status === "confirmed");
  ok(entries.length >= 9, `the persona's confirmed entries: ${entries.length}`);
  for (const f of entries) ok(printed.has(String(f.id)), `${f.title || f.text} prints in the edited version`);
  ok(!r.changes.some((c: any) => c.kind === "drop"), `no drop is reported for an edited version: ${JSON.stringify(r.changes.filter((c: any) => c.kind === "drop"))}`);
  ok(/Every other entry on your record still prints/.test(r.changelog), r.changelog);
  // The tool's flag to the model never calls the tool's own count the person's ask.
  const tools = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => ({ job_id: p.id, title: p.title, company: p.company, description: p.description }), personas: { get: async () => ({ items: [], active: null }), put: async () => {} } as any, resumes: memoryResumeStore(), render: edgeRenderer(), deliver: () => {} } } as any).map((t: any) => [t.name, t]));
  const out: any = await tools.tailor_resume.run({ job_id: p.id, edits: [{ role: "pixelforge", lines: 1 }, { role: "waypoint", lines: 6 }] }, { userId: "00000000-0000-4000-8000-000000001167", threadId: "t", now: NOW, state: { profile: ctx.profile }, turn: { message: P.C20, added: [] } } as any);
  const flag = out.review_draft.flags.find((f: string) => /Waypoint/.test(f));
  ok(flag && !/6 lines were asked/.test(flag) && /never say they asked for a number/.test(flag), flag);
  // The reply guard: live-6's "not the 6 you asked for" (the person typed no 6) is put back once, then removed if it stays.
  eq(misquotedAsks(LIVE6.C20, [P.C20]).map((m) => m.figure), ["6"]);
  eq(misquotedAsks("Pixelforge is down to the one line you asked for.", [P.C20]), [], "\"one line\" is theirs");
  eq(misquotedAsks("You asked for 5 roles and I found 2.", ["find me 5 internships"]), []);
  const s = scripted(() => text(LIVE6.C20));
  const t = await turn(P.C20, s.model);
  ok(s.seen.some((x) => /they never gave that number/.test(x.system)), "the model is told once");
  ok(!/the 6 you asked for/.test(t.reply), t.reply);
});

Deno.test("D67-5 C8 (G2): an internal fact id never reaches the person", async () => {
  const o = { tools: [], typed: P.C8, postings: new Map() };
  eq(leakedWords(LIVE6.C8, o), ["F-002"]);
  ok(!/F-0\d\d/.test(stripLeaks(LIVE6.C8, o)) && /still on file as confirmed, even though/.test(stripLeaks(LIVE6.C8, o)));
  const s = scripted(() => text(LIVE6.C8.slice(0, 400)));
  const r = await turn(P.C8, s.model);
  ok(s.seen.some((x) => /internal words the person must never see: F-002/.test(x.system)), "asked once in plain words");
  ok(!/F-0\d\d/.test(r.reply), r.reply);
  eq(leakedWords("My F-1 visa ends in June.", { ...o, typed: "my F-1 visa" }), [], "a visa class is not an id");
});

Deno.test("D67-6 C1 (G4): a posting's pay stated per place keeps its place (Chicago's range for the Chicago posting)", async () => {
  const p = POSTINGS[0];
  ok(paysByPlace(p.description).length >= 5, "PayPal's pay-by-location table");
  eq(placedPay(p.description, p.location), "$28- $49 Hourly (Chicago, Illinois)");
  ok(placedPay(p.description, null)!.startsWith("San Jose, California: $32 - $55 Hourly; Austin, Texas: $28- $49 Hourly; Chicago, Illinois: $28- $49 Hourly"), "no place known: every range with its place");
  eq(placedPay("Pay: $40-$50/hr. Benefits.", "Chicago, IL"), "$40-$50/hr", "one pay: as before");
  // search_jobs (live-6 C1's source of "$32 - $55 hourly" for Chicago) and get_posting.
  const pool = POSTINGS.map((x) => ({ job_id: x.id, company: x.company, title: x.title, location: x.location, url: x.url, description: x.description }));
  const hit = searchPostings(pool, "software engineer intern", null).postings.find((h: any) => h.company === "PayPal")!;
  eq(hit.pay, "$28- $49 Hourly (Chicago, Illinois)");
  const tools = Object.fromEntries(careerTools({ postings: async () => [], posting: async () => pool[0] } as any).map((t: any) => [t.name, t]));
  eq((await tools.get_posting.run({ job_id: pool[0].job_id }, { userId: "u", threadId: "t", now: NOW, state: {} } as any)).pay, "$28- $49 Hourly (Chicago, Illinois)");
  // Owner, must-fix (d): the figure carries its source link: a reply that gives PayPal's pay without the posting's link gets it.
  const said = "PayPal's Software Engineer Intern posting in Chicago lists $28 to $49 an hour.";
  eq(payWithSource(said, [hit as any]), `${said}\n\n${hit.url}`);
  eq(payWithSource(`${said}\n${hit.url}`, [hit as any]), `${said}\n${hit.url}`, "already linked");
  eq(payWithSource("PayPal has one posting open.", [hit as any]), "PayPal has one posting open.", "no figure, no link added");
  // Through the turn: search_jobs, then a reply with the figure and no link.
  const s = scripted((_p, n) => n === 0 ? use("search_jobs", { query: "software engineer intern" }) : text(said));
  const t = await turn("what does the paypal internship pay?", s.model, { postings: async () => pool });
  ok(t.reply.includes(hit.url) && /\$28/.test(t.reply), t.reply);
});

Deno.test("D67-7 C1 (G1/G11): no record write offered on a pure question; a plan ask gets its plan File", async () => {
  ok(statesNothing(P.C1), "\"i need to lock in\" is a task for now, not a fact");
  ok(statesNothing(P.C6) && !statesNothing("I'm a junior at Lakeshore, what internships fit?") && !statesNothing("I'm looking for a SWE internship."));
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const plan = { title: "SWE internship plan", variant: "pipeline", period: "This week", sections: [{ heading: "Apply", items: [{ label: "PayPal", value: "Apply this week.", source: "From you" }] }] };
  const s = scripted((_p, n) => [use("search_jobs", { query: "software engineer intern" }), text("Fix the GPA line, then apply to PayPal."), use("create_file", { kind: "plan_review", data: plan }, "t2"), text("Fix the GPA line, then apply to PayPal; the plan is in the file.")][n] ?? text("ok"));
  const r = await turn(P.C1, s.model, { files, postings: async () => [] });
  ok(!s.seen[0].tools.some((t: any) => t.name === "add_profile_fact"), "add_profile_fact is not offered on this turn");
  ok(s.seen[0].tools.some((t: any) => t.name === "remember_instruction"), "other tools still are");
  ok(s.seen.some((x) => /create_file \(kind plan_review\)/.test(x.system)), "one review asks for the plan File");
  eq(r.tool_calls.map((c) => [c.name, c.ok]), [["search_jobs", true], ["create_file", true]]);
  ok((r as any).fileLinks?.[0]?.startsWith("https://trainee.example/file?t=v1."));
  // The statement in a question is still saveable (D-065 D65-4 stands).
  const s2 = scripted(() => text("ok"));
  await turn("I'm a junior at Lakeshore, what internships fit?", s2.model);
  ok(s2.seen[0].tools.some((t: any) => t.name === "add_profile_fact"));
});

// The benchmark persona's confirmed profile (its two setup turns through the router), so live-6's replies trace to its facts.
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR))).setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
// A shortener that keeps every sentence carrying a figure, link, boundary, caveat or the closing question and drops others from
// the end of the body until the text is within the bound: faithful by construction (it only deletes whole sentences).
function faithful(long: string, bound: number): string {
  const ss = long.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const must = (x: string, k: number) => k === 0 || /\d|https?:\/\/|\?$|\b(?:not|never|nothing|no|haven'?t|couldn'?t|can'?t|don'?t|unverified|unconfirmed)\b/i.test(x);
  const keep = ss.map((x, k) => ({ x, k, m: must(x, k) }));
  for (let k = keep.length - 1; k >= 0 && textLength(keep.map((y) => y.x).join(" ")) > bound; k--) if (!keep[k].m) keep.splice(k, 1);
  return keep.map((y) => y.x).join(" ");
}

Deno.test("D67-8 G3: the length pass runs on a turn whose tools only read, and takes a faithful shorter version of live-6's replies", async () => {
  // The diagnosis (live-6: no answer turn without a write came under its bound): condensable() counted every effect, "read"
  // included, and its name test matched "profile" and "resume" in read tools, so any turn that looked something up was never
  // shortened. A read is not a write; a refused write wrote nothing.
  const long = "x".repeat(900);
  ok(condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "get_profile", ok: true, effect: "read" }] } as any, { max: -1 }), "get_profile");
  ok(condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "read_resume", ok: true, effect: "read" }, { name: "search_jobs", ok: true, effect: "read" }] } as any, { max: -1 }), "read_resume, search_jobs");
  ok(condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "add_profile_fact", ok: false, effect: "write_own" }] } as any, { max: -1 }), "a refused write");
  ok(!condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "add_profile_fact", ok: true, effect: "write_own" }] } as any, { max: -1 }), "a write that happened");
  ok(!condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "tailor_resume", ok: false, effect: "write_own" }] } as any, { max: -1 }), "a resume tool");
  // live-6's own long answers (each over its kind's bound), after a read: one pass, accepted when faithful and within the bound.
  let shortened = 0;
  // (C8 is a recall list with a leaked id: its id strip is D67-5; a sentence-dropping shortener is no fair stand-in for a list.)
  for (const id of ["C4", "C7", "C11", "C12", "C15", "C17"]) {
    const reply = LIVE6[id], bound = overLimit(replyLength(P[id]));
    if (textLength(reply) <= bound) continue;
    const short = faithful(reply, bound);
    const s = scripted((_p, n) => n === 0 ? use("get_profile", {}) : text(reply), () => short);
    const r = await turn(P[id], s.model, { history: [{ role: "assistant", content: reply }], stores: { profile: personaProfile() } });
    eq(s.seen.filter((p) => !p.tools?.length).length, 1, `${id}: one shortening pass ran`);
    if (textLength(short) <= bound && shortenedOk(reply, short, bound)) { eq(r.reply, short, `${id}: the faithful shorter text is the reply`); shortened++; }
  }
  // C7 and C15 come within the bound by dropping whole sentences alone; the others keep a figure or caveat in every sentence, so
  // this stand-in cannot shorten them enough (the model rewrites wording; the guards are the same).
  ok(shortened >= 2, `the pass shortened ${shortened} of live-6's long answers`);
});

Deno.test("D67-9 C6 (G14): an ask about their own applications reads read_application_mail first", async () => {
  ok(historyAskOf(P.C6) && historyAskOf("did i already apply to paypal?") && !historyAskOf(P.C11) && !historyAskOf(P.C1));
  const mail = readTool("read_application_mail", { applied: [{ company: "Bank A", role: "Summer Analyst", confirmed_by: "gmail" }] });
  const s = scripted((_p, n) => [text("No, nothing on record yet."), use("read_application_mail", {}), text("Yes: your Gmail shows Bank A (Summer Analyst).")][n] ?? text("ok"));
  const r = await turn(P.C6, s.model, { capabilities: [mail] });
  ok(/call read_application_mail first/.test(s.seen[0].system), "the turn note");
  ok(/did not read their record/.test(s.seen[1].system), "one process review");
  eq(r.tool_calls.map((c) => c.name), ["read_application_mail"]);
  ok(/Bank A/.test(r.reply));
  // Owner, must-fix (b): a reply that says they have not applied, to any ask, is checked against the record first.
  for (const x of [LIVE6.C6, "You haven't applied anywhere yet.", "You have no applications on record."]) ok(SAYS_NOT_APPLIED.test(x), x);
  for (const x of ["Nothing was sent or submitted.", "I haven't submitted anything for you.", "No applications were sent by me."]) ok(!SAYS_NOT_APPLIED.test(x), x);
  const s2 = scripted((_p, n) => [text("You haven't applied anywhere yet, so start with PayPal."), use("read_application_mail", {}), text("Your Gmail shows Bank A; start with PayPal next.")][n] ?? text("ok"));
  const r2 = await turn("what should i focus on this week?", s2.model, { capabilities: [mail] });
  ok(/did not read their record/.test(s2.seen[1].system), "the claim itself triggers the check");
  eq(r2.tool_calls.map((c) => c.name), ["read_application_mail"]);
});

Deno.test("D67-10 C22 (G7): pay already shown in the conversation is used; a named posting is read before research", async () => {
  const shown = [{ role: "user", content: P.C11 }, { role: "assistant", content: "PayPal's posting lists $28-$49 hourly for Chicago, as the posting states it.\nhttps://paypal.wd1.myworkdayjobs.com/x" }];
  eq(shownPayOf(P.C22, shown), [{ text: "PayPal's posting lists $28-$49 hourly for Chicago, as the posting states it.", url: "https://paypal.wd1.myworkdayjobs.com/x" }]);
  eq(shownPayOf(P.C8, shown), [], "not a pay ask");
  const none: MarketResult = { status: "no_sources", format: "inline", notes: [], searched: "test", note: "" };
  const said = "PayPal's Chicago posting lists $28-$49 hourly. I couldn't confirm a wider going rate from the pages I read.";
  eq(enforceMarketReply(said, none, shownPayOf(P.C22, shown)), `${said}\nhttps://paypal.wd1.myworkdayjobs.com/x`, "the figure already shown stands, with its source link and the honest clause");
  eq(enforceMarketReply(said, none), "I couldn't confirm a wider going rate from the pages I read.", "without it on record, the figure goes as before");
  eq(enforceMarketReply("Interns make $60 an hour.", none, shownPayOf(P.C22, shown)), NO_SOURCES, "a figure not shown is still never said");
  const s = scripted(() => text("ok"));
  await turn(P.C22, s.model, { history: shown });
  ok(/PAY THIS CONVERSATION ALREADY SHOWED/.test(s.seen[0].system) && /\$28-\$49 hourly for Chicago/.test(s.seen[0].system));
  // A posting they named: research before reading it gets one review.
  const check = processCheck({ draftAsk: false, planSearch: false, parts: [], posting: true })!;
  ok(/Call get_posting on it now/.test(check("x", [{ name: "research_market", ok: true }]) ?? ""));
  eq(check("x", [{ name: "get_posting", ok: true }, { name: "research_market", ok: true }]), null);
  eq(check("x", []), null, "no research, nothing owed");
});

Deno.test("D67-11 (owner, must-fix (e)): every File and tracker link the reply carries opens through the File server and holds what the reply says", async () => {
  const U = "33333333-3333-4333-8333-333333333367", BASE = "https://trainee.example/file";
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-d067-0123456789-abcdef", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
  const store = memoryFileStore();
  const files = createFileService({ store, env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const A = signedIn();
  const stub = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; },
    async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } } as unknown as FileStore;
  const deps: FileDeps = { ...A.deps, store: stub, now: () => NOW, env: { get: (k: string) => ENV[k] }, cards: { async open() { throw new Error("no"); } } as never, tap: {} as never, files } as FileDeps;
  // The person's own signed-in browser (a phone session); each link from the chat is followed in it, exactly as a tap would.
  const sid = await A.tok(U, "chat", NOW);
  const open = async (link: string): Promise<{ status: number; body: string }> => {
    let res = await handleFile(new Request(link, { headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin } }), deps);
    for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
      const to = new URL(res.headers.get("location") ?? "", link).toString();
      res = await handleFile(new Request(to, { headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin } }), deps);
    }
    return { status: res.status, body: await res.text() };
  };
  const plain = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ");
  const said = async (r: any) => { const out: string[] = []; for (const l of (r.fileLinks ?? []) as string[]) { const o = await open(l); eq(o.status, 200, `${l} opens: ${o.body.slice(0, 200)}`); out.push(plain(o.body)); } return out; };
  const stores = () => ({ profile: { facts: structuredClone(FACTS) }, discovery: { lastShortlist: [{ id: POSTINGS[0].id, company: "PayPal", title: POSTINGS[0].title, location: "Chicago, IL", url: POSTINGS[0].url }] } });
  // 1. The plan File (C1): the reply says the plan is in the file; the page opens and holds the plan's steps.
  const plan = { title: "SWE internship plan", variant: "pipeline", period: "This week", sections: [{ heading: "Apply", items: [{ label: "PayPal Software Engineer Intern", value: "Apply by Friday after fixing the GPA line.", source: "From you" }] }] };
  const s1 = scripted((_p, n) => [use("create_file", { kind: "plan_review", data: plan }), text("Fix the GPA line, then apply to PayPal; the plan is in the file.")][n] ?? text("ok"));
  const r1: any = await agentTurn({ message: "make me a plan page for this week", history: [], stores: stores(), userId: U, threadId: "th", now: NOW, model: s1.model, files } as any);
  eq(r1.fileLinks?.length, 1, "one link, minted by code");
  const [page1] = await said(r1);
  ok(/in the file/.test(r1.reply), r1.reply);
  ok(page1.includes("SWE internship plan") && page1.includes("Apply by Friday after fixing the GPA line."), page1.slice(0, 400));
  // 2. The tracker (C16): export_tracker's page opens and holds the researched PayPal role the reply names.
  const caps = capabilityTools({ mail: { applications: async () => [], events: async () => [] } as any, tracking: false, accounts: async () => [], cursor: null, readNow: null, connectUrl: "https://trainee.example/connect", situation: null, snapshot: null, files, people: null, inbox: null, reply: null });
  const s2 = scripted((_p, n) => [use("export_tracker", {}), text("Your tracker has PayPal as researched, not applied. Gmail isn't connected, so confirmations aren't in it yet.")][n] ?? text("ok"));
  const r2: any = await agentTurn({ message: "yea set up that application tracker", history: [], stores: stores(), userId: U, threadId: "th", now: NOW, model: s2.model, capabilities: caps } as any);
  eq(r2.tool_calls.map((c: any) => [c.name, c.ok]), [["export_tracker", true]]);
  const [page2] = await said(r2);
  ok(page2.includes("Application tracker") && page2.includes("PayPal"), page2.slice(0, 400));
  // 3. A link that does not open is caught: a changed token is refused by the File server (the check above is real).
  const bad = await open(r1.fileLinks[0].replace(/.$/, (c: string) => (c === "A" ? "B" : "A")));
  ok(bad.status >= 400, `a tampered link does not open: ${bad.status}`);
  // 4. No "made" or "attached" without the call that made it: the claim is put to the model once, then removed.
  eq(unbackedClaims("I've made you a tracker page with every application.", []).map((c) => c.kind), ["a file made"]);
  eq(unbackedClaims("The full plan is in the file.", [{ name: "research_market", ok: true, effect: "read" }]).map((c) => c.kind), ["a file made"], "research that answered inline made no file");
  eq(unbackedClaims("The full plan is in the file.", [{ name: "create_file", ok: true, effect: "write_own" }]), []);
  eq(unbackedClaims("Your resume is attached.", [{ name: "tailor_resume", ok: false, effect: "write_own" }]).map((c) => c.kind), ["a file made"], "a refused tailor attached nothing");
  const s3 = scripted(() => text("I've made you a tracker page with every application. Nothing was sent."));
  const r3: any = await turn("yea set up that application tracker", s3.model);
  ok(s3.seen.some((x) => /a file made/.test(x.system)), "asked once");
  ok(!/made you a tracker page/.test(r3.reply) && !(r3.fileLinks ?? []).length, r3.reply);
});
