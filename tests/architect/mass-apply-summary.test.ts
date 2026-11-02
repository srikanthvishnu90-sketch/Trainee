// MASS APPLY (2026-11-01): after a batch, "where are my applications" opens with every application counted by what
// happened, and lists the ones waiting on the person first, so none of them is below the list's cut. Synthetic rows only.
import assertNode from "node:assert/strict";
import { countsLine, statusReply } from "../../supabase/functions/_shared/career_apply_status.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-01T18:00:00Z");
const row = (i: number, state: string, reason: string | null = null) => ({ id: `j${i}`, company: `TEST Co ${i}`, url: `https://boards.greenhouse.io/co${i}/jobs/${i}`, state, reason,
  confirmation_id: null, email_confirmed_at: null, created_at: new Date(NOW - 3600000).toISOString(), updated_at: new Date(NOW - i * 60000).toISOString(), title: "Frontend Engineering Intern" });

Deno.test("a batch of 12: counted by outcome, the captcha one listed first though it is the oldest", () => {
  const rows = [...Array.from({ length: 7 }, (_, i) => row(i + 1, "submitted_unconfirmed")), row(8, "not_submitted", "needs_answers"), row(9, "not_submitted", "posting_closed"),
    row(10, "queued"), row(11, "not_submitted", "CARD_CLOUD_AUTH_REFUSED"), row(12, "needs_user", "bot_check")];
  eq(countsLine(rows as any), "12 applications: 7 submitted, 1 waiting on you, 3 not sent, 1 approved and not sent yet.");
  const r = statusReply("where are my applications", rows as any, NOW)!;
  assert(r.reply.startsWith("12 applications: 7 submitted, 1 waiting on you, 3 not sent, 1 approved and not sent yet.\nYour applications, the ones waiting on you first, then newest first:\n- TEST Co 12"), r.reply);
});

Deno.test("one application: no counts line, as before", () => {
  const r = statusReply("where are my applications", [row(1, "submitted_unconfirmed")] as any, NOW)!;
  assert(r.reply.startsWith("Your applications, newest first:\n- TEST Co 1"), r.reply);
});

Deno.test("every row is counted once: failed and any other state counted, the counts add up to the total", () => {
  const rows = [row(1, "submitted_unconfirmed"), row(2, "failed", "Invalid phone"), row(3, "unknown_outcome"), row(4, "confirmed"), row(5, "some_new_state")];
  eq(countsLine(rows as any), "5 applications: 1 confirmed by the employer, 1 submitted, 1 may have gone (unknown), 1 turned down by the employer's form, 1 other.");
});

Deno.test("a closed posting is said in words, never its code", () => {
  const r = statusReply("where are my applications", [row(1, "not_submitted", "POSTING_CLOSED"), row(2, "submitted_unconfirmed")] as any, NOW)!;
  assert(/TEST Co 1[^\n]*this posting closed before it could be submitted; nothing was sent/.test(r.reply) && !/POSTING_CLOSED/.test(r.reply), r.reply);
});
