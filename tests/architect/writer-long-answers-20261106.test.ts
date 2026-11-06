// WRITER ROOT CAUSES + LONG ANSWERS WHOLE (beta C11/C12, 2026-11-06; rootcause-report PR-1 and PR-2).
//   C11: a rewrite that named the person's own words ("QA analyst") was rejected as an invented name, because the person's
//        message was not in the facts; a fabricated employer must still be refused.
//   C12: the writer re-judged the brain's own reply, rejected a checklist for "more than one question", and the template
//        deleted checklist items 3-5 (questions); then the shape kept a ~700-character head, one capped follow-up (tail
//        dropped) and stored only the head.
// Pure functions and a scripted fake model only: no network, no real model, no database.
import assertNode from "node:assert/strict";
import {
  factCheck, factsForTurn, PAYLOAD_INTENTS, rewrites, templateReply, voiceCheck, withoutInternal, writable, writeReply,
} from "../../supabase/functions/_shared/career_reply_writer.ts";
import {
  ANSWER_MAX_CHARS, answerParts, MAX_ANSWER_PARTS, PART_MAX_CHARS, PARTS_LEFT_NOTE, planSends, shapeForTurn, shapeReply,
} from "../../supabase/functions/_shared/channel_shape.ts";
import { OUTBOX_CHARS } from "../../supabase/functions/_shared/conversation.ts";
import { replyParts } from "../../supabase/functions/_shared/channel_inbound.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// The verbatim beta inputs (brief/beta-inputs.json).
const C11 = "Read-only beta test C11. Compare software QA analyst and IT help desk as entry-level career paths in general, not for my personal profile. Explain day-to-day work, transferable skills, training needed and tradeoffs. Separate general guidance from anything needing current local research. Do not claim current openings or salaries without sources. No profile changes, reminders, outreach or applications.";
const C12 = "Read-only beta test C12. How should someone with no prior coding background decide whether a paid coding bootcamp is worth it? Give a practical due-diligence checklist, distinguish advertised placement rates from reliable evidence, and mention cheaper ways to test interest first. General advice only, no claims about my background, no purchases, profile changes, reminders or external actions.";

const facts = (reply: string, intent: string | null = "career_recommendations") =>
  factsForTurn({ reply, intent, resultStatus: "completed", effects: { sent: 0, queued: 0, sendUnknown: 0, writes: new Set() }, situation: null });

// The router's no-openings answer that C11 got (rootcause-report D1/C11).
const ROUTER_SAID = "I don't have verified current openings from the last day, so I won't claim any. Which employer source should I check first?";

Deno.test("C11: a rewrite naming the person's own words (QA analyst, IT help desk) has no 'name not in the facts' violation", () => {
  const rewrite = "No verified openings to show yet, so I won't claim any for QA analyst or IT help desk roles. Which employer source should I check first?";
  const without = factCheck(rewrite, facts(ROUTER_SAID));
  ok(without.some((v) => /name "QA" is not in the facts/.test(v)), `before the fix (no message) QA reads as invented: ${JSON.stringify(without)}`);
  const v = factCheck(rewrite, facts(ROUTER_SAID), C11);
  ok(!v.some((x) => /not in the facts/.test(x) && /QA|IT|analyst/i.test(x)), JSON.stringify(v));
  eq(v, [], "nothing else is flagged either");
});

Deno.test("C11: a fabricated employer, status, promise or changed number still violates with the message in hand", () => {
  const f = facts(ROUTER_SAID);
  ok(factCheck("Google has QA analyst openings right now. Which employer source should I check first?", f, C11).some((v) => /name "Google"/.test(v)), "an employer nobody named");
  ok(factCheck("I have openings from stripe for QA analyst roles.", f, C11).some((v) => /"stripe" after "from"/.test(v)), "a lowercase employer after a preposition");
  // the message's words never make a status or a promise a fact ("applications", "outreach" are in C11)
  ok(factCheck("I applied to two QA analyst roles for you.", f, C11).some((v) => /says "applied"/.test(v)), "a status from nowhere");
  ok(factCheck("I'll research QA analyst salaries tonight.", f, C11).some((v) => /promises "research"/.test(v)), "a promise from nowhere");
  // a number the person gave may be restated as it is; a changed one is refused
  const pay = facts("Here is how to think about the offer.");
  eq(factCheck("At $24/hour, here is how to think about the offer.", pay, "They offered me $24/hour."), []);
  ok(factCheck("At $26/hour, here is how to think about the offer.", pay, "They offered me $24/hour.").some((v) => /number 26/.test(v)));
});

const BRAIN = `Before you pay for a bootcamp, do the cheap checks first.
1. Try a free course for two weeks and see if you still want to code.
2. Ask for the bootcamp's outcomes report in writing.
3. Is the placement rate audited by a third party?
4. Does it count only graduates who found a job in the field?
5. What share of the class finished at all?
6. Talk to two graduates from a year ago, not the ones the school picks.
Want me to turn this into a one-page checklist?`;

Deno.test("C12: the brain's own reply passes through the writer byte-identical, and the model is never called", async () => {
  let called = 0;
  const model = async () => { called++; return { content: [{ type: "text", text: "a shorter rewrite?" }] }; };
  const out = { intent: "agent", reply: BRAIN, handler: "agent" };
  eq(rewrites(out, null, { structured: false }), false, "the handler gate refuses the brain's reply");
  eq(writable(out, null, { structured: false }), true, "it is still writable for the channel shape");
  eq(rewrites({ ...out, handler: "router" }, null, { structured: false }), true, "a router reply is still written");
  const w = await writeReply({ on: true, handler: "agent", facts: facts(BRAIN, "agent"), message: C12, model });
  eq(w.text, BRAIN); eq(w.source, "skipped"); eq(called, 0);
});

Deno.test("C12: templateReply keeps all 6 checklist items when items 3-5 end in '?'", () => {
  const t = templateReply(facts(BRAIN, "outreach_draft"));
  for (const item of BRAIN.split("\n").filter((l) => /^\d\. /.test(l))) ok(t.includes(item), `kept: ${item}\n---\n${t}`);
  eq((t.match(/^\d\. /gm) ?? []).length, 6);
  // the prose question strip still holds outside the list: only the last prose question stays
  const two = templateReply(facts("Which city? And which role do you want next?", "x"));
  eq(two, "And which role do you want next?");
});

Deno.test("C12: the voice check counts questions only outside list items; length room is today's reply + 20%", () => {
  const f = facts(BRAIN, "career_recommendations");
  ok(!voiceCheck(BRAIN, f).some((v) => /more than one question/.test(v)), JSON.stringify(voiceCheck(BRAIN, f)));
  ok(voiceCheck("Which city? Which role?", facts("x")).includes("more than one question"));
  ok(!voiceCheck("Check three things: 1) Is it accredited? 2) Is the rate audited? Want the list?", facts("x")).some((v) => /more than one question/.test(v)), "an inline numbered list counts as items");
  const said = "A sentence that is the answer. ".repeat(20).trim(); // 619 chars
  ok(!voiceCheck("x".repeat(Math.floor(said.length * 1.2)), facts(said)).some((v) => /longer than/.test(v)));
  ok(voiceCheck("x".repeat(Math.ceil(said.length * 1.2) + 1), facts(said)).some((v) => /longer than/.test(v)));
});

Deno.test("C12: a rejected rewrite of a non-payload turn returns today's reply unchanged (internal words out only)", async () => {
  const said = `${BRAIN}\nThe router chose this in the career_recommendations handler.`;
  const bad = async () => ({ content: [{ type: "text", text: "Google says skip bootcamps. Want the list?" }] });
  const w = await writeReply({ on: true, handler: "router", facts: facts(said), message: C12, model: bad });
  eq(w.source, "template"); ok(w.rejected.length > 0);
  eq(w.text, BRAIN, "every item kept, only the internal sentence gone");
  eq(withoutInternal("1. Ask the router for the rate?\n2. Talk to graduates."), "1. Ask the for the rate?\n2. Talk to graduates.", "a list item keeps its place");
  // a payload intent still falls back to the template (never reached in production: payload turns are not written)
  ok(PAYLOAD_INTENTS.has("outreach_draft"));
  const p = await writeReply({ on: true, facts: facts(said, "outreach_draft"), message: C12, model: bad });
  eq(p.text, templateReply(facts(said, "outreach_draft")));
  // a write the output cap cut off is never served
  const cut = await writeReply({ on: true, facts: facts(BRAIN), message: C12, model: async () => ({ content: [{ type: "text", text: "Do the cheap checks first." }], stop_reason: "max_tokens" }) });
  eq([cut.source, cut.text], ["template", BRAIN]);
});

// A 4,500-character, 6-item answer (C12's shape).
const item = (n: number) => `${n}. Item ${n}: ${`Check this point about bootcamp ${n} with real evidence before you pay anything. `.repeat(9).trim()}`;
const LONG = [`Here is how to vet a paid coding bootcamp before you spend money on it.`, ...[1, 2, 3, 4, 5, 6].map(item)].join("\n");

Deno.test("long answer: a 4,500-char 6-item answer is whole-sentence parts that concatenate to the input in order", () => {
  ok(LONG.length > 4300 && LONG.length < 4700, String(LONG.length));
  eq(PART_MAX_CHARS, OUTBOX_CHARS, "a part is never over the outbox's limit");
  const { parts, left } = answerParts(LONG);
  eq(left, "");
  ok(parts.length >= 2 && parts.length <= MAX_ANSWER_PARTS, String(parts.length));
  for (const p of parts) ok(p.length <= PART_MAX_CHARS && /[.!?]$/.test(p), `${p.length}: ${p.slice(-30)}`);
  ok(parts[0].length <= ANSWER_MAX_CHARS, "the answer comes first, short");
  eq(norm(parts.join("\n")), norm(LONG), "nothing cut, nothing dropped, in order");
  const at = [1, 2, 3, 4, 5, 6].map((n) => parts.join("\n").indexOf(`${n}. Item ${n}:`));
  ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), `items 1-6 in order: ${at}`);
  eq(replyParts(parts), parts, "the parts contract delivers them as they are");
});

Deno.test("long answer: the turn's reply (what agent-chat commits) is the whole answer and contains item 4", () => {
  const link = "https://www.bls.gov/ooh/computer-and-information-technology/";
  const sh = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: `${LONG}\n${link}`, allowedLinks: [link] });
  ok(sh.parts && sh.parts.length >= 2);
  ok(sh.reply.includes(item(4)), "item 4 is in the stored reply");
  eq(sh.reply, `${LONG}\n${link}`, "the whole answer, and the link it shows");
  eq(sh.shape?.links, [link]);
  ok(!sh.parts!.some((p) => p.includes(link)), "the link rides as its own message, not inside a part");
  const s = shapeReply({ answer: LONG });
  eq(planSends(s).map((x) => x.kind), s.parts!.map(() => "answer"), "one message per part, in order");
  // the handler puts sh.reply into out.reply and sh.parts into out.parts; respond() commits out.reply as response.reply
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  ok(/if \(sh\.reply !== out\.reply\) out = \{ \.\.\.out, reply: sh\.reply \};\s*\n\s*if \(sh\.parts\) out = \{ \.\.\.out, parts: sh\.parts \};/.test(src));
  ok(!/splitLongAnswer|overflowLink/.test(src), "no head-only or page-overflow path is left");
});

Deno.test("long answer: past 4 parts the last part ends on a sentence with an honest note; the stored reply keeps all of it", () => {
  const huge = Array.from({ length: 400 }, (_, i) => `Point ${i} is one more thing to check before you pay.`).join(" ");
  const { parts, left } = answerParts(huge);
  eq(parts.length, MAX_ANSWER_PARTS);
  ok(left.length > 0 && parts[parts.length - 1].endsWith(PARTS_LEFT_NOTE));
  for (const p of parts) ok(p.length <= PART_MAX_CHARS);
  eq(norm([...parts.slice(0, -1), parts[parts.length - 1].slice(0, -PARTS_LEFT_NOTE.length), left].join(" ")), norm(huge), "what was sent plus what is left is the whole answer");
  const sh = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: huge });
  eq(sh.reply, huge);
  ok(sh.notes.some((n) => /were not sent \(the stored reply has them\)/.test(n)));
});

Deno.test("long answer: SMS, WhatsApp and web are not shaped (their own limits stand); a short answer is one message", () => {
  for (const channel of ["sms", "whatsapp", "web"]) eq(shapeForTurn({ on: true, channel, writable: true, reply: LONG }), { reply: LONG, parts: null, shape: null, notes: [] });
  const short = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: "Short and direct." });
  eq([short.reply, short.parts], ["Short and direct.", null]);
});
