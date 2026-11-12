// D-065 (architect, 2026-11-12): the fixes for live round 1 (live-5: 1/26 turns matched Instinct on the five checks). Each test
// names the ruling it serves (P3); none is keyed to a benchmark prompt's wording beyond using the benchmark's messages as inputs.
// $0: the real agent turn (career_brain.ts agentTurn, loop.ts) with a scripted model; no network.
//   D65-1  G3 length: per-kind bounds; one shortening pass when a reply is >10% over its kind's upper end, under code's guards.
//   D65-2  G10/D-059: a draft ask goes through draft_followup; a draft written in prose gets one process review; a long draft is
//          shortened only in its wording, before it is shown, and only when the shorter text passes the same draft check.
//   D65-3  C9: a research ask's named parts are each covered (turn note + one completion pass).
//   D65-4  C1 (G1/D-007): no record write from a question or request; a plan ask aimed at postings searches first.
//   D65-5  C16 (D-024): a page a tool made reaches the person with its link, on channels that cannot send a link on its own.
//   D65-6  C12 (G5): an unverified capacity is never affirmed (instruction and turn note).
//   D65-7  the spending-limit refusal is said as one (never "an error on its side, not a limit"), and nothing was sent.
//   D65-8  the mirror runner's test world (eval only): recorded postings and Gmail served; research GETs pass only live.
//   deno test -A --no-check tests/architect/d065-live-round1-20261112.test.ts
import assertNode from "node:assert/strict";
import { agentTurn, processCheck, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { askedPartsOf, capacityAskOf, draftAskOf, overLimit, partsMissing, planSearchAskOf, replyLength, statementsOf, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { MIRROR_RULES } from "../../supabase/functions/_shared/agent/prompt.ts";
import { heldReply, nextStepOf, stopOfError } from "../../supabase/functions/_shared/limit_stop.ts";
import { ModelUnavailableError } from "../../supabase/functions/_shared/model_calls.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import { parseTelegramUpdate } from "../../supabase/functions/_shared/telegram.ts";
import { CONFIRMATIONS, PAYPAL_CXS, POSTINGS, worldFetch, worldGmail } from "../../evals/mirror/instinct-wa-batch1/world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const INSTINCT: Record<string, number> = Object.fromEntries(read("instinct.jsonl").map((t: any) => [t.id, t.messages.filter((m: string) => !/^https?:\/\//.test(m)).join(" ").length]));
const NOW = Date.parse("2026-11-12T03:00:00Z");
const FACTS = [
  { id: "F-001", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" },
  { id: "F-002", kind: "experience", text: "Pixelforge, Founder (2023-2025): hand-coded 70+ React websites for clients", status: "confirmed" },
];
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
type Payload = { system: string; messages: any[]; tools: any[] };
// A scripted model: `brain` answers calls that offer tools (the turn itself), `plain` the tool-less calls (the shortener).
function scripted(brain: (p: Payload, n: number) => any, plain: (p: Payload) => string = () => "") {
  const seen: Payload[] = [];
  let n = 0;
  const model = async (p: any) => { seen.push(p); return p.tools?.length ? brain(p, n++) : text(plain(p)); };
  return { model, seen };
}
const turn = (message: string, model: any, extra: Record<string, unknown> = {}) =>
  agentTurn({ message, history: [], stores: { profile: { facts: structuredClone(FACTS) } }, userId: "u-d065", threadId: "th-d065", now: NOW, model, ...extra } as any);

Deno.test("D65-1 G3: each kind's bound is its upper end plus 10%; a long answer is shortened once, keeping every link, caveat and boundary", async () => {
  eq([replyLength(P.C2), replyLength(P.C14), replyLength(P.C5), replyLength(P.C23), replyLength(P.C4), replyLength(P.C8)].map(overLimit), [396, 220, 330, 220, 550, 1320]);
  // Instinct's own reply sits within the bound on the benchmark's turns of each kind (C15 and C17 are its two long answers).
  for (const id of ["C2", "C13", "C14", "C5", "C21", "C23", "C4", "C7", "C11", "C12", "C8", "C5f1", "C5f2"]) ok(INSTINCT[id] <= overLimit(replyLength(P[id])), `${id}: Instinct ${INSTINCT[id]}`);
  eq(textLength("See https://example.test/a-very-long-link-that-does-not-count\nok"), 6, "links apart");
  const long = "Lead with your name and contacts, then Lakeshore University, the degree and June 2029. ".repeat(8) + "I can't verify which template a given recruiter prefers. Nothing was sent.\nhttps://career.example.edu/resume-guide";
  const short = "Lead with your name and contacts, then Lakeshore University, the degree and June 2029, then a skills line. I can't verify which template a given recruiter prefers. Nothing was sent.\nhttps://career.example.edu/resume-guide";
  const s1 = scripted(() => text(long), () => short);
  // The guide link was shown earlier in the conversation, so the reply may carry it (career_brain.ts shownBefore).
  const SHOWN = [{ role: "user", content: "any resume guide?" }, { role: "assistant", content: "This one:\nhttps://career.example.edu/resume-guide" }];
  const r = await turn(P.C4, s1.model, { history: SHOWN });
  eq(r.reply, short, "shortened once to the kind's target");
  const pass = s1.seen.find((p) => !p.tools?.length)!;
  ok(/300 to 500 characters/.test(pass.system), "the pass aims at the kind's target");
  // The guards: a dropped link, caveat or boundary, a new figure, or a text still over the bound keeps the reply as written.
  ok(!shortenedOk(long, short.replace("\nhttps://career.example.edu/resume-guide", ""), 550), "a link dropped");
  ok(!shortenedOk(long, short.replace(" I can't verify which template a given recruiter prefers.", ""), 550), "a caveat dropped");
  ok(!shortenedOk(long, short.replace(" Nothing was sent.", ""), 550), "the boundary dropped");
  ok(!shortenedOk(long, short.replace("June 2029", "June 2030"), 550), "a figure not in the long reply");
  ok(!shortenedOk("Hi [Name], " + long, short, 550), "a placeholder dropped");
  ok(!shortenedOk(long, short.replace(" and June 2029", ""), 550), "a figure dropped");
  // A prose "draft" kind is a rewrite of their own text ("make the answer less formal"), never cut to a draft's length here.
  const s5 = scripted(() => text("Proposed replacement: " + "I like work where data helps someone decide. ".repeat(8)), () => "short");
  await turn("Make the answer less formal.", s5.model); eq(s5.seen.filter((p) => !p.tools?.length).length, 0);
  const s2 = scripted(() => text(long), () => "Lead with your name. Done.");
  eq((await turn(P.C4, s2.model, { history: SHOWN })).reply, long, "a failed guard: the long reply stands");
  // A reply within the bound, and an ask that asks for detail, are never shortened.
  const s3 = scripted(() => text("A short answer. Nothing was sent."), () => "x");
  await turn(P.C4, s3.model); eq(s3.seen.filter((p) => !p.tools?.length).length, 0);
  const s4 = scripted(() => text("Week 1: do this. ".repeat(120)), () => "short");
  await turn("give me a detailed plan for my whole job search, everything", s4.model); eq(s4.seen.filter((p) => !p.tools?.length).length, 0, "a detailed plan is the person's length");
});

Deno.test("D65-2 G10: a draft ask goes through draft_followup; prose drafts get one review; a long draft is shortened before it is shown", async () => {
  for (const id of ["C2", "C13", "C14"]) ok(draftAskOf(P[id]), id);
  for (const id of ["C4", "C10", "C17", "C19", "C20"]) ok(!draftAskOf(P[id]), id);
  ok(!draftAskOf("write me a cover letter for the paypal role"), "a cover letter is a document");
  // The brain wrote the draft as prose: the process review asks for the tool, and the tool's text is the reply.
  const body = "Hi [Name], I'm a Lakeshore University CS and Finance student. Could you refer me for Google's SWE internship [job link]? Thanks!";
  const s1 = scripted((p, n) => n === 0 ? text(`Here's a draft:\n\n${body}\n\nNothing was sent.`) : n === 1 ? use("draft_followup", { kind: "note", recipient: "", body }) : text("ok"));
  const r1 = await turn(P.C2, s1.model);
  ok(/THIS IS A DRAFT ASK/.test(s1.seen[0].system), "the turn note");
  ok(/Call draft_followup now/.test(s1.seen[1].system), "one process review");
  eq(r1.tool_calls.map((c) => c.name), ["draft_followup"]);
  // Architect amendment (D-067): the draft comes first and its label after it (G2, answer first); the bar stands: the reply is the tool's checked text and the not-sent label still appears.
  eq(r1.reply, `${body}\n\nDraft, not sent.`, "the reply is the tool's text");
  // A draft over the bound: shortened only in its wording, before it is shown; the shorter text passes the same draft check.
  const longBody = "Hi [Name], I'm a Lakeshore University CS and Finance student. I hand-coded 70+ React websites for clients at Pixelforge. " +
    "I'm applying for Google's SWE internship [job link], and I'd be grateful for a short chat about your team and, if you think I'm a fit, a referral. Thanks either way, I appreciate your time and any advice.";
  const shortBody = "Hi [Name], I'm a Lakeshore CS and Finance student. I built 70+ React sites for clients. Could you refer me for Google's SWE internship [job link]? Thanks!";
  const s2 = scripted((_p, n) => n === 0 ? use("draft_followup", { kind: "note", recipient: "", body: longBody }) : text("ok"), () => shortBody);
  const C2_SHOWN = [{ role: "user", content: P.C2 }, { role: "assistant", content: `Draft, not sent:\n\n${longBody}` }];
  const r2 = await turn(P.C14, s2.model, { history: C2_SHOWN });
  ok(textLength(`Draft, not sent:\n\n${longBody}`) > 220);
  // Architect amendment (D-067): the draft comes first and its label after it (G2, answer first); the bar stands: the reply is the tool's checked text and the not-sent label still appears.
  eq(r2.reply, `${shortBody}\n\nDraft, not sent.`);
  eq(r2.show?.text, r2.reply, "the shown card is the shorter text");
  // The shorter text invents a figure: the draft check refuses it and the checked draft stands.
  const s3 = scripted((_p, n) => n === 0 ? use("draft_followup", { kind: "note", recipient: "", body: longBody }) : text("ok"), () => "Hi [Name], I built 90 React sites. Refer me for Google's SWE internship [job link]? Thanks!");
  // Architect amendment (D-067): the draft comes first and its label after it (G2, answer first); the bar stands: the reply is the tool's checked text and the not-sent label still appears.
  eq((await turn(P.C14, s3.model, { history: C2_SHOWN })).reply, `${longBody}\n\nDraft, not sent.`);
});

Deno.test("D65-3 C9: a research ask's parts are each covered; a missing part gets one completion pass", async () => {
  eq(askedPartsOf(P.C9), ["culture", "pay", "interview process"]);
  eq(askedPartsOf(P.C22), [], "one part is just the question");
  eq(partsMissing("Pay: the posting lists $235k-$300k base.\nInterviews: three 45-minute rounds.", ["culture", "pay", "interview process"]), ["culture"]);
  const partial = "Pay: the official posting lists a base range.\nInterviews: the second round is three 45-minute interviews.";
  const full = partial + "\nCulture: anonymous accounts describe demanding hours; anecdotes, not proof.";
  const s = scripted((_p, n) => text(n === 0 ? partial : full));
  const r = await turn(P.C9, s.model);
  ok(/THEY ASKED ABOUT THESE PARTS/.test(s.seen[0].system) && /culture, pay, interview process/.test(s.seen[0].system), "the turn note lists the parts");
  ok(/does not cover: culture/.test(s.seen[1].system), "the completion pass names the missing part");
  eq(r.reply, full);
});

Deno.test("D65-4 C1 (G1/D-007): no record write from a question; a plan ask aimed at postings calls search_jobs first", async () => {
  eq(statementsOf(P.C1), { asking: true, stated: "i need to lock in for recruiting" });
  eq(statementsOf("what internships fit me?").stated, "");
  eq(statementsOf("I'm a junior at Lakeshore, what internships fit?").stated, "I'm a junior at Lakeshore");
  eq(statementsOf("I'm looking for a SWE internship for summer 2027, Chicago or remote.").asking, false, "a plain statement asks nothing");
  // The brain tried to save a goal from the question: refused; nothing added.
  const s1 = scripted((_p, n) => n === 0 ? use("add_profile_fact", { kind: "goal", text: "land a SWE internship for next summer" }) : n === 1 ? use("remember_instruction", { instruction: "Lock in for recruiting", quote: "i need to lock in for recruiting" }, "t2") : text("Here's what to do."));
  const stores: any = { profile: { facts: structuredClone(FACTS) } };
  const r1 = await agentTurn({ message: P.C1, history: [], stores, userId: "u", threadId: "t", now: NOW, model: s1.model } as any);
  eq(r1.tool_calls.filter((c) => c.ok).map((c) => c.name), [], JSON.stringify(r1.tool_calls));
  eq(stores.profile.facts.length, FACTS.length, "no fact saved from a question");
  // A statement inside a question is still saved, in the person's words.
  const s2 = scripted((_p, n) => n === 0 ? use("add_profile_fact", { kind: "education", text: "junior at Lakeshore" }) : text("Saved as a draft."));
  const stores2: any = { profile: { facts: [] } };
  const r2 = await agentTurn({ message: "I'm a junior at Lakeshore, what internships fit?", history: [], stores: stores2, userId: "u", threadId: "t", now: NOW, model: s2.model } as any);
  eq(r2.tool_calls.map((c) => [c.name, c.ok]), [["add_profile_fact", true]]);
  // The plan ask that names postings to land searches first: the turn note, and one review when no search ran.
  ok(planSearchAskOf(P.C1) && planSearchAskOf(P.C3, P.C1) && !planSearchAskOf(P.C3) && !planSearchAskOf(P.C4) && !planSearchAskOf("how do i prepare for a google internship interview"));
  const s3 = scripted((_p, n) => n === 0 ? text("Ship one project this week.") : n === 1 ? use("search_jobs", { query: "software engineer intern" }) : text("Found none on the boards I read; ship one project this week."));
  const r3 = await turn(P.C1, s3.model, { postings: async () => [] });
  ok(/call search_jobs first/.test(s3.seen[0].system));
  ok(/no search ran/.test(s3.seen[1].system));
  ok(r3.tool_calls.some((c) => c.name === "search_jobs"));
  eq(processCheck({ draftAsk: false, planSearch: false, parts: [] }), null, "no check when nothing is owed");
});

Deno.test("D65-5 C16 (D-024): a page a tool made reaches the person with its link on a channel that cannot send links on their own", async () => {
  // The agent turn keeps the File link as code's (fileLinks); the channel sends it after the answer.
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const data = { title: "Plan", variant: "pipeline", period: "This week", sections: [{ heading: "Plan", items: [{ label: "Step", value: "Ship one project.", source: "From you" }] }] };
  const s = scripted((_p, n) => n === 0 ? use("create_file", { kind: "plan_review", data }) : text("Your plan page is made."));
  const r = await turn("make me a plan page for this week", s.model, { files });
  const link = (r as any).fileLinks?.[0] as string;
  ok(link?.startsWith("https://trainee.example/file?t=v1."), String(link));
  // WhatsApp / iMessage: no sendLink. The link rides the answer, on its own line; Telegram (sendLink) still sends it on its own.
  const run = async (sendLink: boolean) => {
    const stored: string[] = [], links: string[] = [];
    const store: any = { async claimMessage() { return true; }, async person() { return { userId: "u", threadId: "th", contact: "wa:1" }; }, async sawInbound() {}, async setOptOut() {}, async setThread() {},
      async enqueueReply(_u: string, _k: string, t: string) { stored.push(t); return true; } };
    const d: any = { env: { get: () => undefined }, now: () => NOW, store, render: (x: string) => [x], deliver: async () => {}, reply: async () => ({ ok: true }),
      chat: async () => ({ status: 200, reply: r.reply, threadId: "th", shape: { attachments: [], links: [link] } }),
      ...(sendLink ? { sendLink: async (x: any) => { links.push(x.url); return { ok: true }; } } : {}) };
    await runInbound(parseTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "make me a plan page" } }).message!, d);
    return { stored, links };
  };
  const wa = await run(false);
  eq(wa.stored.join("\n"), `Your plan page is made.\n${link}`, "the link is in the answer the person gets");
  const tg = await run(true);
  ok(!tg.stored.join("\n").includes(link) && tg.links.includes(link), "Telegram: the link is its own message, not repeated");
});

Deno.test("D65-6 C12 (G5): a capacity never verified is never affirmed", async () => {
  ok(capacityAskOf(P.C12));
  for (const id of ["C1", "C3", "C11", "C19"]) ok(!capacityAskOf(P[id]), id);
  ok(/Never affirm a volume or pace of work you have not verified/.test(MIRROR_RULES));
  const s = scripted(() => text("I haven't verified that pace. Nothing was queued."));
  await turn(P.C12, s.model);
  ok(/THEY ASK WHETHER YOU CAN DO A VOLUME OR PACE OF WORK/.test(s.seen[0].system) && /technically yes/.test(s.seen[0].system));
});

Deno.test("D65-7 a spending-limit refusal is said as one, and nothing was sent", () => {
  const credit = new ModelUnavailableError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
  const usage = new ModelUnavailableError(400, "invalid_request_error", "You have reached your specified API usage limits (mirror runner cap $1.8).");
  eq([stopOfError(credit), stopOfError(usage)], ["spend_limit", "spend_limit"]);
  eq(stopOfError(new ModelUnavailableError(500, "api_error", "")), null, "an outage is still not a limit");
  const said = heldReply("is that paypal internship posting still open? check rn", "spend_limit", null);
  ok(/stopped at a spending limit/.test(said) && /nothing was sent/.test(said), said);
  ok(!/not a limit|error on its side/.test(said), said);
  ok(/not a limit/.test(nextStepOf("outage", null)), "a real outage keeps its words");
});

Deno.test("D65-8 the mirror runner's world: recorded postings and Gmail served; research GETs pass only on a live run", async () => {
  ok(POSTINGS.some((p) => p.company === "PayPal" && /Software Engineer Intern/.test(p.title) && p.location === "Chicago, IL"));
  ok(POSTINGS.every((p) => p.description.length > 200), "descriptions from the recordings");
  const gmail = worldGmail(NOW);
  eq(gmail.inbox.length, CONFIRMATIONS.length);
  ok(gmail.inbox.every((m) => NOW - m.at < 3 * 86_400_000), "inside the first mail read");
  const net: string[] = [];
  const realFetch = (async (r: Request) => { net.push(`${r.method} ${r.url}`); return new Response("page"); }) as unknown as typeof fetch;
  const live = worldFetch({ live: true, realFetch, gmail }), dry = worldFetch({ live: false, realFetch, gmail });
  const ua = { headers: { "user-agent": "TraineeBot/1.0 (+https://trainee.chat/bot)" } };
  ok((await (await live(new Request(PAYPAL_CXS)))!.json()).jobPostingInfo.title, "the recorded CXS answer for its own URL");
  ok(await live(new Request("https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process/", ua)), "live: a research GET goes out");
  eq(await dry(new Request("https://www.citadel.com/careers/", ua)), null, "dry: refused below");
  eq(await live(new Request("https://www.citadel.com/careers/")), null, "not the research reader");
  eq(await live(new Request("https://www.citadel.com/x", { method: "POST", body: "{}", headers: ua.headers })), null, "only GETs");
  eq(await live(new Request("https://www.linkedin.com/in/someone", ua)), null, "never LinkedIn");
  eq(await live(new Request("https://boards-api.greenhouse.io/v1/boards/acme/jobs", ua)), null, "never a board's whole listing");
  eq(await live(new Request("https://jobs.lever.co/acme/123/apply", ua)), null, "never an application step");
  eq(net, ["GET https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process/"]);
  eq(gmail.sent.length, 0);
});
