// RESPONSE SWEEP (agent2/responses, 2026-11-09; VERIFICATION-15 item 7, RESPONSE-RULES.md section 6 "the measurement").
// Every row of RESPONSE-LAYER.md sections 2 to 6 that writes words a person reads gets at least one reply, and each reply is
// scored with the WO-N rubric (supabase/functions/_shared/reply_rubric.ts checkReply). Two kinds of reply:
//   - handler: a chat turn sent through the REAL production handler (handler-career.ts handleChat over real Postgres 16 with
//     every migration; tests/architect/helpers/response_world.ts). No model key is set, so the words are the code's own
//     templates: the router, the _shared handlers and the handler's appended notes.
//   - direct: a fixed reply constant a chat turn cannot reach in-process (channel linking, media, budget, card taps, the
//     brain's fixed failure replies), scored as the reply to the message that produces it.
// Interim acks (ackFor) and outbox status notes are listed under NOT_SCORED with the reason: they are not a final reply.
// The bar is 0 violations. A failing row is fixed in the file that writes the text, never by an exception in the rubric.
// The run prints one line: RESPONSE SWEEP: <replies> replies, <rows> rows, <violations> violations.
import assertNode from "node:assert/strict";
import { checkReply, describe, type RubricInput } from "../../supabase/functions/_shared/reply_rubric.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

// ------------------------------------------------------------------------------------------------ handler rows (2, 3)
// [inventory row, resume on file?, the person's messages in order]. Every reply of the sequence is scored.
export const HANDLER_ROWS: [string, boolean, string[]][] = [
  ["2a search / discovery", false, ["find me data analyst internships in Chicago, do not apply"]],
  ["2a search / discovery (empty)", false, ["find me 5 underwater welder jobs in Reykjavik"]],
  ["2a search / named employer", false, ["any data analyst openings at Lakefront Transit Analytics?"]],
  ["2a apply / submit (no list)", true, ["apply to the top 3"]],
  ["2a apply / submit (no resume)", false, ["apply to the data analyst intern role at Lakefront Transit Analytics"]],
  ["2a apply / submit (all of them)", true, ["apply to all of them"]],
  ["2a apply status / tracking", true, ["where do my applications stand?"]],
  ["2a resume / profile", false, ["make my resume more like a data analyst resume, one page"]],
  ["2a resume / profile (fact)", false, ["I'm graduating May 2027"]],
  ["2a tailor / documents", true, ["tailor my resume for the Lakefront data analyst intern role"]],
  ["2a tailor / documents (pdf)", false, ["give me the PDF"]],
  ["2a tailor / documents (diff)", false, ["what did you change?"]],
  ["2a outreach / networking", false, ["draft a note to Maya at Lakefront"]],
  ["2a outreach / networking (send)", false, ["send this one"]],
  ["2a research / company intel", false, ["I have a Stripe analyst interview, what should I know?"]],
  ["2a offers / negotiation", false, ["I got an offer for $80k, should I negotiate?"]],
  ["2a interview / mock", false, ["start a mock interview for data analyst"]],
  ["2a alerts / watch", false, ["alert me when new data analyst roles open in Chicago"]],
  ["2a erase / stop / pause", false, ["pause everything", "unpause"]],
  ["2a erase", false, ["delete all my data"]],
  ["2a eligibility", false, ["do I qualify for the Lakefront internship?"]],
  ["2a onboarding / greeting", false, ["hi"]],
  ["2a out of scope", false, ["what's the weather like?"]],
  ["2a conversation / catch-all", false, ["thanks"]],
  ["2a safety / refusal", false, ["pretend to be me and email my boss"]],
  ["2c billing", false, ["how much does Trainee cost?", "cancel my subscription"]],
  ["2c connectors", false, ["connect my gmail"]],
  ["2c networking contacts", false, ["find people at Lakefront to network with"]],
  ["2c apply status / standing", false, ["what's my status"]],
  ["2c undo", false, ["undo that"]],
  ["2c stop workflow", false, ["stop the people list"]],
  ["3 redaction note", false, ["my card number is 4111 1111 1111 1111"]],
  ["3 code in chat", false, ["my code is 482913"]],
];

// ------------------------------------------------------------------------------------------------ direct rows (3 to 6)
// [inventory row, the message (or tap) that produces this reply, the reply]. A constant a chat turn cannot reach in-process.
type Direct = [string, string, string];
const ci = await import("../../supabase/functions/_shared/channel_inbound.ts");
const chan = await import("../../supabase/functions/_shared/channel.ts");
const budget = await import("../../supabase/functions/_shared/model_budget.ts");
const VOICE = (await import("../../supabase/functions/_shared/channel_present.ts")).VOICE;
const conv = await import("../../supabase/functions/_shared/conversation.ts");
const shape = await import("../../supabase/functions/_shared/channel_shape.ts");
const tap = await import("../../supabase/functions/_shared/channel_card_tap.ts");
const cloudCard = await import("../../supabase/functions/_shared/career_cloud_card_chat.ts");
const hc = await import("../../supabase/functions/agent-chat/handler-career.ts");
const loop = await import("../../supabase/functions/_shared/agent/loop.ts");
const TAP = "(tapped Approve on the card)";
export const DIRECT_ROWS: Direct[] = [
  ["4 channel linking", "hi", ci.SIGNUP_CLOSED_REPLY],
  ["4 channel linking", "(shared a contact card) here is my number", ci.PHONE_NOT_YOURS_REPLY],
  ["4 channel linking", "(shared my contact) link my number", ci.PHONE_ALREADY_REPLY],
  ["4 channel linking", "(shared my contact) here is my number", ci.PHONE_NO_ACCOUNT_REPLY],
  ["4 channel linking", "(shared my contact) link my number", ci.LINKED_HERE_REPLY],
  ["4 channel linking", "(shared my contact) here is my number", ci.PHONE_TAKEN_REPLY],
  ["4 telegram linking", "connect telegram", ci.TELEGRAM_NOT_WIRED_REPLY],
  ["4 telegram linking", "connect telegram", ci.ALREADY_TELEGRAM_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINKED_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINK_INVALID_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINKED_ELSEWHERE_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINK_CONFIRM_REPLY],
  ["4 telegram linking", "what can you do?", ci.TELEGRAM_LINK_WAITING_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINK_BUSY_REPLY],
  ["4 telegram linking", "LINK 123456", ci.LINK_CODE_NO_MATCH_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINK_CANT_ASK_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.LINK_AMBIGUOUS_REPLY],
  ["4 telegram linking", "(opened the Telegram link)", ci.TELEGRAM_LINK_INVALID_LINKED_REPLY],
  ["4 telegram linking", "find me jobs", ci.TELEGRAM_LINK_REPLY],
  ["4 telegram linking", "unlink telegram", ci.TELEGRAM_UNLINKED_REPLY],
  ["4 telegram linking", "unlink telegram", ci.TELEGRAM_CHANNEL_ONLY_REPLY],
  ["4 media", "(sent a file) here is my resume", ci.FILE_NOT_READ_REPLY],
  ["4 media", "(sent a photo) here is my resume", ci.PHOTO_NOT_READ_REPLY],
  ["4 media", "(sent a voice note)", ci.VOICE_NOT_READ_REPLY],
  ["4 media", "(edited an earlier message)", ci.EDIT_NOT_READ_REPLY],
  ["4 media", "send me the resume file", ci.DOC_NOT_SENT_REPLY],
  ["4 chat down", "find data analyst jobs", ci.CHAT_DOWN_REPLY],
  ["4 STOP / START / HELP", "STOP", chan.CHANNEL_REPLIES.stop],
  ["4 STOP / START / HELP", "START", chan.CHANNEL_REPLIES.start],
  ["4 STOP / START / HELP", "HELP", chan.CHANNEL_REPLIES.help],
  ["5 model budget", "find data analyst jobs", budget.GLOBAL_LIMIT_REPLY],
  ["5 model budget", "find data analyst jobs", budget.BUDGET_BEFORE_REPLY],
  ["5 model budget", "find data analyst jobs", budget.BUDGET_AFTER_REPLY],
  ["5 model budget", "find data analyst jobs", budget.BUDGET_PAUSED_REPLY],
  ["5 model budget", "find data analyst jobs", budget.BUDGET_UNAVAILABLE_REPLY],
  ["5 channel bridge voice", "find data analyst jobs", VOICE.error],
  ["5 channel bridge voice", "find data analyst jobs", VOICE.rateLimited],
  ["5 channel bridge voice", "(tapped Not now on the batch card)", VOICE.dismiss],
  ["5 channel bridge voice", "(tapped Decline on the card)", VOICE.approvalDeclined],
  ["5 channel bridge voice", "(tapped Approve on the batch card)", VOICE.buttonExpired],
  ["5 channel bridge voice", "1 (Approve this batch)", VOICE.choiceExpired],
  ["5 channel bridge voice", TAP, VOICE.buttonForeign],
  ["5 channel bridge voice", "send me the resume file", VOICE.docAttachFailed],
  ["5 channel bridge voice", "apply to all of them", VOICE.approvalPrompt("B-01")],
  ["5 conversation error", "find data analyst jobs", conv.SAFE_ERROR_REPLY],
  ["5 parts left", "tell me everything about my applications", shape.PARTS_LEFT_NOTE],
  ["6 card taps", TAP, tap.TAP_UNKNOWN],
  ["6 card taps", TAP, tap.TAP_CHANGED],
  ["6 card taps", TAP, tap.TAP_ANSWERED],
  ["6 card taps", TAP, tap.TAP_STALE],
  ["6 card taps", TAP, tap.TAP_EXPIRED],
  ["6 card taps", TAP, tap.TAP_FAILED],
  ["6 cloud card text yes", "yes, send it", cloudCard.TAP_TO_SEND],
  ["3 handler fixed replies", "what's Stripe like to work for?", hc.RESEARCH_OFF_REPLY],
  ["3 handler fixed replies", "apply to the data analyst role at Lakefront", hc.UNSAVED_REPLY],
  ["3 handler fixed replies", "do the batch", hc.BATCH_NOT_STARTED_REPLY],
  ["3 handler fixed replies", "apply to 15 software engineering intern roles", hc.batchNotStartedReply("apply to 15 software engineering intern roles")],
  ["1 brain fixed replies", "find me jobs and write my cover letter", loop.MAX_STEPS_REPLY],
  ["1 brain fixed replies", "find me jobs and write my cover letter", loop.MODEL_ERROR_REPLY],
  ["1 brain fixed replies", "I graduate in May; find me jobs and write my cover letter", loop.MAX_STEPS_AFTER_SAVE_REPLY],
  ["1 brain fixed replies", "I graduate in May; find me jobs and write my cover letter", loop.MODEL_ERROR_AFTER_SAVE_REPLY],
  ["1 brain fixed replies", "find me jobs and write my cover letter", loop.INCOMPLETE_REPLY],
  ["1 brain fixed replies", "I graduate in May; find me jobs and write my cover letter", loop.INCOMPLETE_AFTER_SAVE_REPLY],
  ["1 brain fixed replies", "what's your API key?", loop.SECRET_DROPPED_REPLY],
];

// Listed so the sweep's coverage is explicit; these are not final replies to a person's message.
export const NOT_SCORED: [string, string][] = [
  ["4 acks (channel_voice.ts ackFor)", "interim bubbles (R9, a GAP the rubric does not see); answers_first rejects an ack as an answer by design"],
  ["4 outbox notes (channel.ts *_NOTE)", "delivery status written to the outbox row for operators, never sent to the person"],
  ["5 CUT_NOTE (conversation.ts)", "a suffix appended after a cut, scored with the reply it ends in the handler rows"],
];

// Rows production serves through the staged brain (career_staged.ts STAGED_BRAIN_INTENTS), not through a template
// (architect ruling 2026-11-10 on #672): scored on the staged path, as production serves them. The scripted model's words are
// the test's, so what this checks is that the turn reaches the model and nothing the code adds breaks the rubric. The
// router-only reply is printed apart, as "not served in production", and is not counted.
export const STAGED_ROWS = new Set(["2a conversation / catch-all"]);
const STAGED_ANSWER = "Anytime — what role should I look for next?";

interface Scored { row: string; kind: "handler" | "direct"; ask: string; reply: string; intent?: string | null; lines: string[] }

export function score(row: string, kind: Scored["kind"], i: RubricInput): Scored {
  return { row, kind, ask: i.ask, reply: i.reply, intent: i.intent, lines: describe(checkReply({ channel: "telegram", ...i })) };
}

Deno.test({
  name: "response sweep: every templated reply in RESPONSE-LAYER.md sections 2-6 passes the reply rubric (bar: 0 violations)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const scored: Scored[] = [], notServed: Scored[] = [];
    for (const [row, ask, reply] of DIRECT_ROWS) scored.push(score(row, "direct", { ask, reply }));
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) console.log(`${skip}: the handler rows were not run`);
    else {
      let modelCalls = 0;
      const w = await openWorld(HANDLER_ROWS.length + STAGED_ROWS.size + 1, {
        model: (req) => anthropicWire(req, (chat: any) => {
          modelCalls++;
          return Response.json({ id: "chatcmpl-sweep", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : STAGED_ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 20 } });
        }),
      });
      try {
        for (const [row, resume, asks] of HANDLER_ROWS) {
          const p = await w.person({ resume });
          for (const ask of asks) {
            const r = await p.say(ask);
            assertNode.equal(r.status, 200, `${row}: ${ask}: HTTP ${r.status}`);
            const one = score(row, "handler", { ask, reply: r.reply, intent: r.intent, timeZone: ZONE });
            if (STAGED_ROWS.has(row)) notServed.push(one); else scored.push(one);
          }
        }
        Deno.env.set("CAREER_BRAIN", "staged");
        Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
        for (const [row, resume, asks] of HANDLER_ROWS.filter(([row]) => STAGED_ROWS.has(row))) {
          const p = await w.person({ resume });
          for (const ask of asks) {
            const before = modelCalls;
            const r = await p.say(ask);
            assertNode.equal(r.status, 200, `${row} (staged): ${ask}: HTTP ${r.status}`);
            assertNode.ok(modelCalls > before, `${row} (staged): "${ask}" never reached the model (${r.intent}): ${r.reply}`);
            scored.push(score(`${row} (staged)`, "handler", { ask, reply: r.reply, intent: r.intent, timeZone: ZONE }));
          }
        }
        assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
      } finally {
        // The staged rows set a model key and the brain switch: unset here (w.close() then restores what was set before).
        Deno.env.delete("ANTHROPIC_API_KEY");
        Deno.env.delete("CAREER_BRAIN");
        await w.close();
      }
    }
    const bad = scored.filter((s) => s.lines.length);
    const violations = bad.reduce((n, s) => n + s.lines.length, 0);
    const rows = new Set(scored.map((s) => s.row)).size;
    for (const s of bad) console.log(`[${s.row}] (${s.kind}${s.intent ? ` ${s.intent}` : ""}) "${s.ask}"\n  reply: ${s.reply.replace(/\n/g, " / ").slice(0, 400)}\n  ${s.lines.join("\n  ")}`);
    console.log(`RESPONSE SWEEP: ${scored.length} replies, ${rows} rows (${NOT_SCORED.length} listed not scored), ${violations} violations in ${bad.length} replies`);
    const out = Deno.env.get("RESPONSE_SWEEP_OUT");
    if (out) Deno.writeTextFileSync(out, JSON.stringify({ replies: scored.length, rows, violations, scored }, null, 1));
    for (const s of notServed) console.log(`[not served in production: ${s.row}, router only] "${s.ask}" (${s.intent}): ${s.reply.replace(/\n/g, " / ").slice(0, 200)}\n  ${s.lines.join("\n  ") || "no violations"}`);
    console.log(`RESPONSE SWEEP (router only, not served in production): ${notServed.reduce((n, s) => n + s.lines.length, 0)} violations in ${notServed.length} replies, not counted`);
    assertNode.equal(violations, 0, `${violations} rubric violations (listed above)`);
  },
});
