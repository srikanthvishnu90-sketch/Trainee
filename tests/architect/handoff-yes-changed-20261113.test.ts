// Round 2 (review of #818), item 9: after a yes to a card that is no longer current, the reply says what the person can actually do
// next. It never says "say done and I'll re-check" when "done" does nothing for that row. No database, no model: the real
// handoffTurn over a scripted store, and the next turn's "done" checked against what the reply promised.
import assertNode from "node:assert/strict";
import { handoffTurn, type HandoffRow, type HandoffStore } from "../../supabase/functions/_shared/career_apply_handoff.ts";

const SHOWN = "a".repeat(64), NEWER = "b".repeat(64);
const store = (rows: HandoffRow[]): HandoffStore => ({ rows: () => Promise.resolve(rows), done: () => Promise.resolve({ ok: false, why: "no_handoff_waiting" }), yes: () => Promise.resolve({ ok: true }), lastShown: () => Promise.resolve({ id: "r1", hash: SHOWN }) });
const base = { id: "r1", company: "TEST Employer", handoff_done_at: "2026-11-13T10:00:00Z" };

Deno.test("a yes to a card that is no longer current: the reply promises only what the next turn does", async () => {
  // A newer card on the row: "done" shows it.
  const newer: HandoffRow = { ...base, state: "needs_user", reason: "ready_for_yes", evidence: { answers_card: { hash: NEWER, answers: [{ field: "Email", value: "t@example.invalid" }] } } };
  const y1 = await handoffTurn({ message: "yes", userId: "u", threadId: "t", store: store([newer]) });
  assertNode.match(y1!.reply, /Say done and I'll show you the answers the page holds now/);
  assertNode.equal((await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([newer]) }))?.intent, "career_apply_handoff_card", "done does show it");
  // A re-check running: "done" in a minute.
  const queued: HandoffRow = { ...base, state: "queued", reason: null, evidence: {} };
  const y2 = await handoffTurn({ message: "yes", userId: "u", threadId: "t", store: store([queued]) });
  assertNode.match(y2!.reply, /re-checking the page now; say done in a minute/);
  assertNode.equal((await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([queued]) }))?.status, "rechecking");
  // The row was stopped (APPROVED_APPLICATION_CHANGED: not_submitted, so no longer among the hand-off rows): "done" does nothing.
  const y3 = await handoffTurn({ message: "yes", userId: "u", threadId: "t", store: store([]) });
  assertNode.doesNotMatch(y3!.reply, /say done/i);
  assertNode.match(y3!.reply, /nothing was sent, and this hand-off is closed: I can't re-check it from here/);
  assertNode.equal(await handoffTurn({ message: "done", userId: "u", threadId: "t", store: store([]) }), null, "and done indeed does nothing");
  for (const y of [y1, y2, y3]) assertNode.equal(y!.status, "refused");
});
