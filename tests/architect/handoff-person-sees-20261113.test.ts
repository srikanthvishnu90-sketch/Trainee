// Review of #797, the reply side (supabase/functions/_shared/career_apply_handoff.ts): no reply tells the person their answers are
// already filled, or to keep off Submit, on a form their own browser opens empty. The fact comes from the row the VM wrote
// (evidence.handoff.person_sees, workers/career-browser/handoff.cjs); the card names the values the employer's page set itself
// and says how many hidden fields it cannot show. No database, no model: the real handoffTurn over a scripted store.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { cardText, handoffTurn, type HandoffRow, type HandoffStore } from "../../supabase/functions/_shared/career_apply_handoff.ts";

const require = createRequire(import.meta.url);
const { buildHandoff, answersCard } = require("../../workers/career-browser/handoff.cjs");
const FALSE_CLAIM = /already filled|is filled|are filled|do not press submit|don't press submit/i;
const store = (rows: HandoffRow[]): HandoffStore => ({ rows: () => Promise.resolve(rows), done: () => Promise.resolve({ ok: true }), yes: () => Promise.resolve({ ok: true }), lastShown: () => Promise.resolve(null) });
const URL_ = "https://acme.bamboohr.com/careers/93";

Deno.test("an in-form check's hand-off: the reply to done says the person's own form opened empty, and nothing claims it was filled", async () => {
  const handoff = buildHandoff({ status: "needs_user", reason: "bot_check", wall: "check_in_form", at: URL_, filled_labels: ["First Name", "Email"] }, { url: URL_ });
  assertNode.equal(handoff.person_sees, "empty_form");
  assertNode.doesNotMatch(handoff.step, FALSE_CLAIM);
  const row: HandoffRow = { id: "r1", company: "TEST Employer", state: "needs_user", reason: "bot_check", handoff_done_at: null, evidence: { handoff } };
  const t = await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([row]) });
  assertNode.equal(t?.status, "rechecking");
  assertNode.match(t!.reply, /your own browser's copy: it opened empty/);
  assertNode.match(t!.reply, /nothing will be sent/);
  assertNode.doesNotMatch(t!.reply, FALSE_CLAIM);
  assertNode.deepEqual(t!.meta, { person_sees: "empty_form" });
  // A sign-in wall: the same reply without that sentence (their browser shows the employer's page from its start).
  const signin = buildHandoff({ status: "needs_user", reason: "login_required", wall: "password", at: URL_ }, { url: URL_ });
  const s = await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([{ ...row, reason: "login_required", evidence: { handoff: signin } }]) });
  assertNode.doesNotMatch(s!.reply, /opened empty/); assertNode.doesNotMatch(s!.reply, FALSE_CLAIM);
  assertNode.deepEqual(s!.meta, { person_sees: "page_from_start" });
  // A row recorded before the fact existed: the reply as it was, no claim either way.
  const old = await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([{ ...row, evidence: { handoff: { step: "x", link: URL_ } } }]) });
  assertNode.doesNotMatch(old!.reply, FALSE_CLAIM); assertNode.equal(old!.meta, undefined);
});

Deno.test("the card: a value the page set itself is marked as the page's, and hidden fields are counted, never shown", () => {
  const card = answersCard({ url: URL_, payload_hash: "ph", fields: [{ label: "Email", held: "test.person@example.invalid", source: "answer" }],
    controls: [{ name: "email", label: "Email", type: "email", value: "test.person@example.invalid", touched: true, hidden: false },
      { name: "office", label: "Preferred office", type: "text", value: "Leeds", touched: false, hidden: false }, { name: "csrf_token", label: "", type: "hidden", value: "secret-token", touched: false, hidden: true }] });
  const text = cardText({ id: "r1", company: "TEST Employer", state: "needs_user", reason: "ready_for_yes", handoff_done_at: "2026-11-13T10:00:00Z", evidence: { answers_card: card } });
  assertNode.match(text, /- Email: test\.person@example\.invalid\n/);
  assertNode.match(text, /- Preferred office: Leeds \(set by the employer's page, not by you\)/);
  assertNode.match(text, /also sends 1 hidden field of its own, which I can't show you/);
  assertNode.doesNotMatch(text, /secret-token/);
  assertNode.match(text, /Nothing has been sent\. Reply yes to submit exactly this/);
});
