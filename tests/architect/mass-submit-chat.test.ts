// D-MS-1 / D-MS-2 (owner, 2026-10-27): mass submission, the conversation side. A person asks to apply to many jobs, sees
// one batch, and approves it with one texted yes on any channel; each item stays bound to its exact payload hash through
// the existing batch approval (career_apply_card_answer_as); nothing new is trusted. Ambiguous replies never approve.
// The database's card half in memory: mass-submit-fixture.ts. Synthetic only; no network, no database.
import assertNode from "node:assert/strict";
import { batchFor, cardTurn, PAGE_CHARS, parseCardReply, type Prepared } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { applyManyAsk, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { db, prep, T } from "./mass-submit-fixture.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// ------------------------------------------------------------------------------------------------ the replies a card takes
Deno.test("D-MS-1/1 every texted answer, messy phrasings included: yes / subset / no / hold / unclear; ambiguous is never an approval", () => {
  const ALL = ["yes", "Yes!", "YES.", "yep", "yeah", "y", "yes please", "yes to all", "Yes to all of them", "approve all", "approve", "approve them",
    "send them", "send them all", "send all", "send it", "submit them", "go ahead", "yes, go ahead", "yes go for it", "do it", "ok send them",
    "sure, send them", "yes approve all", "yes send all 60", "approve all 60", "yes please send them", "yes, approve", "approve it"];
  for (const m of ALL) eq(parseCardReply(m)?.kind, "yes", m), eq((parseCardReply(m) as any).except, [], m);
  const EXCEPT: [string, number[], string[]?][] = [
    ["yes except 3", [3]], ["yes but not 2", [2]], ["Yes except 2, 5 and 7.", [2, 5, 7]], ["yes skip #3", [3]], ["approve, skip 2", [2]],
    ["yes except 3-5", [3, 4, 5]], ["yes, all but 4", [4]], ["yes but leave out 1 and 6", [1, 6]], ["send all except 2", [2]],
    ["yes but not acme", [], ["acme"]], ["yes except Acme and Beta Labs", [], ["acme", "beta labs"]], ["yes, not the gamma one", [], ["gamma"]],
  ];
  for (const [m, nums, names] of EXCEPT) {
    const r = parseCardReply(m) as any;
    eq([r?.kind, r?.except, r?.exceptNames], ["yes", nums, names], m);
  }
  const ONLY: [string, number[], string[]?][] = [
    ["only 1, 2 and 5", [1, 2, 5]], ["just 1 and 2", [1, 2]], ["1, 2 and 5", [1, 2, 5]], ["send 1 and 3", [1, 3]], ["yes to 1 and 3", [1, 3]],
    ["yes 1 and 3", [1, 3]], ["only #4", [4]], ["approve number 2", [2]], ["only acme", [], ["acme"]], ["just 2-4", [2, 3, 4]],
  ];
  for (const [m, nums, names] of ONLY) {
    const r = parseCardReply(m) as any;
    eq([r?.kind, r?.only, r?.onlyNames], ["only", nums, names], m);
  }
  for (const m of ["no", "No.", "nope", "nah", "no thanks", "don't send them", "do not send any", "decline all", "cancel", "none of them", "send none"]) eq(parseCardReply(m)?.kind, "no", m);
  for (const m of ["wait", "Wait!", "hold on", "not yet", "hang on", "let me think", "wait, don't send them", "stop, don't send them yet", "hold off", "later"]) eq(parseCardReply(m)?.kind, "hold", m);
  // Ambiguous: approves nothing, the card asks again in plain words.
  for (const m of ["maybe", "Maybe?", "perhaps", "I guess", "not sure", "idk", "ok", "okay", "sure", "k", "hmm", "yes?", "yes no", "yes, no wait",
    "yes but", "yes except", "only", "1 or 2", "yes to 1 or 2", "approve 2", "yes 3", "send 3", "yes acme", "yes but not the one in Ohio",
    "yes except whatever", "no?", "approve all?"]) {
    eq(parseCardReply(m)?.kind, "unclear", m);
  }
  // "not Acme" alone says what to leave out, not that the rest should go: confirmed first, never approved.
  for (const m of ["not Acme", "not 3", "skip 3", "except 2 and 4"]) eq(parseCardReply(m)?.kind, "except_only", m);
  // Not a card answer at all: the carrier's opt-out, questions, other asks.
  for (const m of ["stop", "STOP", "what is on 2?", "yes I want alerts for data jobs", "3", "how many are there?", "show me remote jobs",
    // A yes that is a sentence about something else (a resume confirmation, a different ask) stays the brain's turn.
    "Yes, that's my resume.", "yes, that's me", "yes please do", "Approve and submit", "Apply on my behalf"]) eq(parseCardReply(m), null, m);
});

// -------------------------------------------------------------------------------------------------- one batch, one yes
Deno.test("D-MS-2/1 sixty jobs: one card shows all 60 (paged for reading), one plain texted yes approves all 60 in one call, the reply says 60", async () => {
  const w = db({ n: 60 });
  const shown = await w.say("show my applications");
  eq(shown?.status, "shown");
  eq(w.cards.length, 1, "one card");
  eq(w.cards[0].items.length, 60, "the whole batch is on it: no 8-per-card limit");
  for (const p of w.prepared) for (const l of p.card_lines) assert(shown!.reply.includes(l), `every line of every application is shown: ${l}`);
  assert(shown!.parts && shown!.parts.length > 1 && shown!.parts.every((p) => p.length <= PAGE_CHARS), "paged for reading, each page one message");
  assert(new RegExp(`This card comes in ${shown!.parts!.length} messages; one "yes" approves all 60\\.`).test(shown!.parts![0]), shown!.parts![0]);
  assert(/Reply "yes" to send all 60/.test(shown!.parts!.at(-1)!), "the foot is on the last page");
  eq(shown!.parts!.join("\n\n"), shown!.reply, "the pages are the card, nothing dropped");
  const yes = await w.say("yes");
  eq(yes?.status, "answered");
  eq(w.answerCalls, [{ card: "C1", approve: Array.from({ length: 60 }, (_, i) => i + 1) }], "one batch approval call, every item");
  eq(w.queue.length, 60, "60 queued");
  eq(w.queue.map((q) => q.approval), w.prepared.map((p) => p.hash), "each by the hash the card carried");
  assert(/^60 approved exactly as shown\. Nothing has gone to an employer yet\./.test(yes!.reply), yes!.reply);
  assert(yes!.parts && yes!.parts.every((p) => p.length <= PAGE_CHARS) && yes!.parts.join("\n") === yes!.reply, "a long answer is paged too");
  // A second yes: the card is answered; nothing more.
  const again = await w.say("yes");
  eq([again?.status, w.queue.length, w.answerCalls.length], ["answered_before", 60, 1]);
  assert(/already answered\. Nothing more was sent/.test(again!.reply), again!.reply);
});

Deno.test("D-MS-1/2 subsets against the card: 'yes except 3', 'only 1, 2 and 5', 'not Acme' (asked first), 'yes but not acme', 'no'; each reply true to the queue", async () => {
  const cases: [string, number[] | null, RegExp][] = [
    ["yes except 3", [1, 2, 4, 5, 6], /^5 approved exactly as shown; 1 of the 6 not sent, each below with why\./],
    ["only 1, 2 and 5", [1, 2, 5], /^3 approved exactly as shown; 3 of the 6 not sent/],
    ["yes but not acme", [2, 3, 4, 5, 6], /\n1\. Acme Robotics: not sent: you left it out/],
    ["yes except Acme and Beta", [3, 4, 5, 6], /\n2\. Beta Labs: not sent: you left it out/],
    ["just gamma and delta", [3, 4], /^2 approved/],
    ["no", [], /^Nothing was approved\. Nothing went to an employer\.\n1\. Acme Robotics: not sent: you said no/],
  ];
  for (const [m, approve, words] of cases) {
    const w = db({ n: 6 });
    await w.say("show my applications");
    const r = await w.say(m);
    eq(r?.status, "answered", m);
    eq(w.answerCalls.map((c) => c.approve), [approve], m);
    eq(w.queue.length, approve!.length, `${m}: the queue holds exactly those`);
    assert(words.test(r!.reply), `${m}: ${r!.reply}`);
  }
  // "not Acme" alone: confirmed first, nothing approved, the card still waits; the next "yes except 1" approves the rest.
  const w = db({ n: 6 });
  await w.say("show my applications");
  const ask = await w.say("not Acme");
  eq([ask?.status, w.answerCalls.length, w.queue.length], ["confirm_except", 0, 0]);
  assert(/Nothing was approved yet\. Reply "yes except 1" to send the other 5 exactly as shown, or "no" to send none\./.test(ask!.reply), ask!.reply);
  const yes = await w.say("yes except 1");
  eq([yes?.status, w.answerCalls.map((c) => c.approve)], ["answered", [[2, 3, 4, 5, 6]]]);
});

Deno.test("D-MS-1/3 never approves: wait, maybe, an unknown number, an employer not on the card, a wrong count, everything left out; the card waits, the next yes approves", async () => {
  const w = db({ n: 3 });
  await w.say("show my applications");
  const cases: [string, string, RegExp][] = [
    ["wait", "hold", /^Okay, holding: nothing was approved and nothing was sent\./],
    ["maybe", "unclear", /^I couldn't tell which ones you mean, so nothing was approved\. Reply "yes" to send all 3 exactly as shown, "yes except 3" or "only 1, 2" to send some, or "no" to send none\./],
    ["yes but not the one in Ohio", "unclear", /nothing was approved/],
    ["1 or 2", "unclear", /nothing was approved/],
    ["yes?", "unclear", /nothing was approved/],
    ["yes except 9", "not_on_card", /^This card has numbers 1 to 3; there is no 9\. Nothing was sent\./],
    ["only 2 and 7", "not_on_card", /there is no 7/],
    ["yes but not Zeta Corp", "not_named", /^No application on this card is from "zeta corp", so nothing was approved\./],
    ["yes send all 60", "count_mismatch", /^This card has 3, not 60, so nothing was approved\./],
    ["yes except 1, 2 and 3", "nothing_left", /^That leaves nothing on this card to approve, so nothing was approved\./],
  ];
  for (const [m, status, words] of cases) {
    const r = await w.say(m);
    eq(r?.status, status, m);
    assert(words.test(r!.reply), `${m}: ${r!.reply}`);
    eq([w.answerCalls.length, w.queue.length, w.cards[0].state], [0, 0, "open"], `${m}: nothing approved, the card still open`);
  }
  const yes = await w.say("yes");
  eq([yes?.status, w.queue.length], ["answered", 3], "after all that, the plain yes approves the batch shown");
});

Deno.test("D-MS-1/4 a payload that changed since it was shown: refused by name, the rest proceed, the reply says which and what to do", async () => {
  const w = db({ n: 4 });
  await w.say("show my applications");
  w.change(2);
  const r = await w.say("yes");
  eq(r?.status, "answered");
  eq(w.answerCalls.map((c) => c.approve), [[1, 2, 3, 4]], "the yes asks for all; the database decides per item by hash");
  eq(w.queuedCompanies(), ["Acme Robotics", "Gamma Data", "Delta Freight"], "the changed one is not queued");
  assert(/^3 approved exactly as shown; 1 of the 4 not sent, each below with why\./.test(r!.reply), r!.reply);
  assert(/\n2\. Beta Labs: not sent: it changed after the card was shown/.test(r!.reply), r!.reply);
  assert(/1 application changed after the card was shown, so it was not approved; say "show my applications" to see it as it is now\./.test(r!.reply), r!.reply);
});

Deno.test("D-MS-1/5 two cards shown: only the latest can be approved; a yes to the older one (by reply) is out of date, approves nothing on either; the plain yes approves the latest", async () => {
  const w = db({ n: 3 });
  const first = await w.say("show my applications");
  const firstMsg = `M-${first!.card_id}-1`; // the message that carried card C1 (the store's naming)
  const second = await w.say("show my applications");
  eq([first?.card_id, second?.card_id], ["C1", "C2"]);
  eq(w.cards.map((c) => c.state), ["answered", "open"], "showing the second closed the first (the database's rule)");
  const old = await w.say("yes", { replyTo: firstMsg });
  eq(old?.status, "card_outdated");
  assert(/out of date: a newer card was shown since, so nothing was approved/.test(old!.reply), old!.reply);
  eq([w.answerCalls.length, w.queue.length], [0, 0]);
  const yes = await w.say("yes");
  eq(yes?.status, "answered");
  eq(w.answerCalls.map((c) => c.card), ["C2"], "the latest card, and only it");
});

Deno.test("D-MS-1/6 expired and already answered: a yes after 10 minutes, after a day, after the card was answered, and after another reply came between; nothing approved", async () => {
  const late = db();
  await late.say("show my applications");
  const r1 = await late.say("yes", { at: T + 11 * 60_000 });
  eq([r1?.status, late.queue.length], ["stale_card", 0]);
  assert(/more than 10 minutes ago, so a text yes can't approve it; nothing was sent\. Say "show my applications" for a fresh card/.test(r1!.reply), r1!.reply);
  const fresh = await late.say("show my applications");
  eq(fresh?.status, "shown", "a fresh card for the same applications");
  eq((await late.say("yes"))?.status, "answered");
  eq(late.queue.length, 3);
  const twice = db();
  await twice.say("show my applications");
  await twice.say("yes except 2");
  const r2 = await twice.say("yes");
  eq([r2?.status, twice.answerCalls.length, twice.queue.length], ["answered_before", 1, 2]);
  const between = db();
  await between.say("show my applications");
  between.otherReply(); // the person asked something else; the brain answered
  eq(await between.say("yes"), null, "a plain yes after another reply is not the card's (the brain's turn)");
  eq(between.answerCalls.length, 0);
});

Deno.test("D-MS-2/2 before builder A's migration the database refuses a card of more than 8: the card shows 8, says how many more wait, and the yes approves those 8", async () => {
  const w = db({ n: 12, cap: true });
  const shown = await w.say("show my applications");
  eq([shown?.status, w.cards.length, w.cards[0].items.length], ["shown", 1, 8]);
  assert(/^8 applications are ready\./.test(shown!.reply) && /4 more are ready; they come on the next card after you answer this one\./.test(shown!.reply), shown!.reply);
  const yes = await w.say("yes");
  eq([yes?.status, w.queue.length], ["answered", 8]);
  assert(/^8 approved exactly as shown\./.test(yes!.reply), yes!.reply);
  const next = await w.say("show my applications");
  eq(w.cards.at(-1)!.items.length, 4, "the next card holds the other 4");
  assert(/^4 applications are ready\./.test(next!.reply), next!.reply);
});

Deno.test("D-MS-2/3 batchFor (NO LIMITS): 400 long applications all go on one card, however many pages, nothing held back; an application too long for a text is named, not cut", () => {
  const long = (i: number): Prepared => ({ id: `L${i}`, company: `Long ${i}`, resume_sha256: "a".repeat(64), card_lines: [`Long ${i}`, ...Array.from({ length: 12 }, (_, k) => `Question ${k}: an answer of some length for posting ${i}, number ${k}.`)] });
  const b = batchFor(Array.from({ length: 400 }, (_, i) => long(i + 1)));
  assert(b && !("tooLong" in b));
  assert(b.take.length === 400 && b.more === 0 && b.parts.length > 30 && b.parts.every((p) => p.length <= PAGE_CHARS), `${b.parts.length} pages, ${b.take.length} shown, ${b.more} more`);
  assert(new RegExp(`This card comes in ${b.parts.length} messages; one "yes" approves all 400\\.`).test(b.parts[0]) && /Reply "yes" to send all 400/.test(b.parts.at(-1)!), b.parts[0].slice(0, 200));
  for (let i = 1; i <= 400; i++) assert(b.text.includes(`${i}. Long ${i}\n`), `item ${i} on the card`);
  // The database's bound before D-MS-2 is the only thing that holds some back, and the card says so.
  const held = batchFor(Array.from({ length: 12 }, (_, i) => long(i + 1)), { max: 8 });
  assert(held && !("tooLong" in held) && held.take.length === 8 && held.more === 4 && /4 more are ready; they come on the next card/.test(held.text));
  const huge: Prepared = { id: "H", company: "Huge Co", resume_sha256: "a".repeat(64), card_lines: ["Huge Co", "x".repeat(5000)] };
  const mixed = batchFor([prep(1), huge, prep(2)]);
  assert(mixed && !("tooLong" in mixed));
  eq(mixed.take.map((p) => p.id), ["P1", "P2"]);
  assert(/Too long to show in a text, so not on this card: Huge Co\. Open it in the app\./.test(mixed.text), mixed.text);
});

// ------------------------------------------------------------------------------------------------- the mass request
const LIST: ShortlistEntry[] = Array.from({ length: 60 }, (_, i) => ({
  id: `greenhouse:mass${i + 1}:${i + 1}`,
  title: i % 3 === 0 ? "Software Engineer Intern" : i % 3 === 1 ? "Data Analyst" : "SWE Intern, Platform",
  company: `Mass Employer ${i + 1}`,
  location: i % 2 === 0 ? "Remote" : "Chicago, IL",
  url: `https://boards.greenhouse.io/mass${i + 1}/jobs/${i + 1}`,
}));
const applyWorld = (o: { resume?: boolean | null } = {}) => {
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, postings: { search: async () => [] }, wants, apps: async () => [], facts: [], shortlist: LIST,
    resumeOnFile: async () => o.resume === undefined ? true : o.resume });
  return { wants, turn, keys: async () => (await wants.list("u1")).map((w) => w.posting_key) };
};

Deno.test("D-MS-2/4 mass asks route to one batch: 'apply me to all of them', 'apply to the top 50', 'apply to all remote ones', 'apply to every SWE intern role you found'", async () => {
  eq(applyManyAsk("apply me to all of them"), { kind: "all" });
  eq(applyManyAsk("apply to the top 50"), { kind: "first", n: 50 });
  eq((applyManyAsk("apply to all remote ones") as any).filter?.remote, true);
  eq((applyManyAsk("apply to every SWE intern role you found") as any).filter?.words, ["swe", "intern"]);
  eq((applyManyAsk("Apply to all the remote internships please") as any).filter, { remote: true, words: ["intern"], said: "remote" });
  for (const m of ["apply to all of them", "apply to them all", "apply to these"]) eq(applyManyAsk(m), { kind: "all" }, m);
  const cases: [string, number, RegExp][] = [
    ["apply me to all of them", 60, /^60\/60 queued;/],
    ["apply to the top 50", 50, /^50\/50 queued;/],
    ["apply to all remote ones", 30, /^30 of the 60 I listed are remote: those 30\. 30\/30 queued;/],
    ["apply to every SWE intern role you found", 40, /^40 of the 60 I listed are swe intern: those 40\. 40\/40 queued;/],
  ];
  for (const [m, n, words] of cases) {
    const w = applyWorld();
    const r = await w.turn(m);
    eq([r?.status, (await w.keys()).length], ["queued", n], m);
    assert(words.test(r!.reply), `${m}: ${r!.reply}`);
    assert(/"show my applications" shows them all on one card, and one yes to that card approves exactly what it shows/.test(r!.reply), r!.reply);
    assert(!/\b(?:8|eight) (?:at a time|per card)|daily limit/i.test(r!.reply), `no limit is claimed: ${r!.reply}`);
  }
  const remote = applyWorld();
  await remote.turn("apply to all remote ones");
  eq((await remote.keys()).every((k) => Number(k.split(":").at(-1)) % 2 === 1), true, "only the remote ones (odd positions are listed Remote)");
  const none = applyWorld();
  const r = await none.turn("apply to all marketing ones");
  eq([r?.status, (await none.keys()).length], ["none", 0]);
  assert(/^None of the 60 I listed are marketing, so nothing was queued\./.test(r!.reply), r!.reply);
});

Deno.test("D-MS-2/6 the resume rule on the big card (#194, owner 2026-10-26): no confirmed resume shows no card; an application that sends no resume is never on the card, so the yes never covers it", async () => {
  const none = db({ n: 60 });
  const r0 = await cardTurn({ message: "show my applications", userId: "TEST-USER", threadId: "TH", now: T, store: none.store, resumeReady: async () => false });
  eq([r0?.status, none.cards.length], ["no_resume", 0]);
  assert(/no confirmed resume on file, so there is no application to show or approve/.test(r0!.reply), r0!.reply);
  const unread = await cardTurn({ message: "show my applications", userId: "TEST-USER", threadId: "TH", now: T, store: none.store, resumeReady: async () => null });
  eq([unread?.status, none.cards.length], ["resume_unreadable", 0]);
  const w = db({ n: 60 });
  for (const i of [5, 17, 42]) (w.prepared[i - 1] as any).resume_sha256 = null; // prepared before a resume was bound
  const shown = await w.say("show my applications");
  eq(w.cards[0].items.length, 57, "the three without a resume are not on the card");
  assert(!shown!.reply.includes("TEST Employer 17: TEST Analyst") && /^57 applications are ready\./.test(shown!.reply), shown!.reply.slice(0, 200));
  await w.say("yes");
  eq(w.queue.length, 57);
  assert(w.queue.every((q) => !["P5", "P17", "P42"].includes(q.prepared_id)), "the yes approved only what was shown");
});

Deno.test("D-MS-2/5 the resume rule holds for a mass ask: no confirmed resume, nothing queued, the reply asks for the resume", async () => {
  for (const m of ["apply me to all of them", "apply to the top 50", "apply to all remote ones", "apply to every SWE intern role you found"]) {
    const w = applyWorld({ resume: false });
    const r = await w.turn(m);
    eq([r?.status, (await w.keys()).length], ["no_resume", 0], m);
    assert(/^0\/\d+ queued\./.test(r!.reply) && /no resume on file/.test(r!.reply) && /Paste or attach your resume, confirm it, then ask again\./.test(r!.reply), r!.reply);
  }
});
