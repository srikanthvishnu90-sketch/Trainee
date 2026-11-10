// WO-021 step 5 (architect): the receipt. Each finished application is said once, as it ended, in the person's words.
// Synthetic rows only.
import { planReceipts, receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import { runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const URL_ = "https://jobs.lever.co/test/1";
const row = (state: string, more: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-0000000000" + state.length.toString().padStart(2, "0"),
  user_id: "TEST-USER",
  company: "TEST Employer",
  url: URL_,
  state,
  ...more,
});
const T = Date.parse("2026-10-20T12:00:00Z");

Deno.test("WO-021/R1 each outcome reads as it ended; confirmed only with the employer's confirmation, not sent says nothing reached them", () => {
  const confirmed = receiptText(row("confirmed", { confirmation_id: "TEST-C-77" }));
  assert(
    confirmed.includes("their page showed TEST-C-77; ") && / has not confirmed it by email yet\./.test(confirmed) && !/^Applied to/.test(confirmed) && confirmed.endsWith(URL_),
    confirmed,
  );
  assert(/has not confirmed it yet/.test(receiptText(row("submitted_unconfirmed"))));
  assert(/emailed you a code/.test(receiptText(row("needs_user", { reason: "email_code" }))));
  assert(/complete a verification/.test(receiptText(row("needs_user", { reason: "captcha" }))));
  const changed = receiptText(row("not_submitted", { reason: "APPROVED_APPLICATION_CHANGED" }));
  assert(/changed after you approved it/.test(changed) && /Nothing reached the employer/.test(changed), changed);
  const odd = receiptText(row("not_submitted", { reason: "SOME_NEW_CODE" }));
  assert(/it stopped before sending \(SOME_NEW_CODE\)\. Nothing reached the employer/.test(odd), odd);
  const unknown = receiptText(row("unknown_outcome"));
  assert(/cannot tell whether it went through, and will not send it again/.test(unknown), unknown);
  assert(/their form said "Phone is invalid"/.test(receiptText(row("failed", { reason: "Phone is invalid" }))));
});

Deno.test("WO-021/R2 nothing is ever said as confirmed unless the row is confirmed", () => {
  for (const s of ["submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"]) {
    const t = receiptText(row(s, { reason: "x", confirmation_id: "TEST-C-1" }));
    assert(!/employer confirmed it on their page|^Applied to/.test(t), `${s}: ${t}`);
  }
});

Deno.test("WO-021/R3 employer text is one line, bounded; a link that is not https is left out", () => {
  const t = receiptText(
    row("failed", { company: "Evil\nCorp " + "x".repeat(500), reason: "a\n\nb", url: "javascript:alert(1)" }),
  );
  assert(!t.includes("\n") && t.length < 500 && !t.includes("javascript:"), t);
});

Deno.test("WO-021/R4 only finished applications get a receipt, one key each", () => {
  const plan = planReceipts([row("queued"), row("driving"), row("confirmed"), row("unknown_outcome")] as any, T);
  eq(plan.map((p) => [p.kind, p.key.startsWith("receipt:")]), [["receipt", true], ["receipt", true]]);
});

Deno.test("WO-021/R5 a run that repeats sends no receipt twice", async () => {
  const outbox = memoryAlertStore();
  const finished = async () => [row("confirmed"), row("not_submitted", { reason: "RESUME_CHANGED" })];
  eq(await runReceipts({ outbox, now: T, finished }), 2);
  eq(await runReceipts({ outbox, now: T + 300000, finished }), 0);
  eq(outbox.dump().outbox.length, 2);
});

Deno.test("WO-021/R6 the scheduled run sends receipts even when nobody has job alerts on, and records how many", async () => {
  const store = memoryAlertStore(), runs: any[] = [];
  let since = "";
  const res = await handleProactive(
    new Request("https://fn.test/career-proactive", {
      method: "POST",
      headers: { "x-trainee-proactive-secret": "z".repeat(40) },
    }),
    {
      env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? "z".repeat(40) : undefined) },
      store: () => store,
      now: () => T,
      recentPostings: async () => [],
      postingsById: async () => [],
      finishedApplications: async (s: string) => {
        since = s;
        return [row("confirmed")];
      },
      recordRun: async (r: any) => {
        runs.push(r);
      },
    },
  );
  eq(res.status, 200);
  eq(since, new Date(T - 26 * 3600000).toISOString(), "reads the last 26 hours");
  eq(runs[0].receipts, 1);
  eq(store.dump().outbox.map((o: any) => o.kind), ["receipt"]);
});
