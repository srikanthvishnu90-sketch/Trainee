// WO-022 step 3 from the scheduled run (architect): the card of prepared applications is shown in the person's texting
// thread without being asked for, once the batch has settled, outside quiet hours, one card per person per run; then a
// texted "yes but not 2" answers it as if the person had asked for it. The database half (no thread, a STOP, an open card,
// a conversation under way, a text missing a line) is proven in tests/db/career_apply_card_push.test.sql.
import { CARD_SETTLE_MS, type ReadyRow, runCards } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { CARD_INTENT, type CardStore, cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const T = Date.parse("2026-10-20T15:00:00Z"); // 11:00 in New York
const ready = (user: string, i: number, agoMin: number, lines = 3, more: Partial<ReadyRow> = {}): ReadyRow => ({
  id: `${user}-P${i}`,
  user_id: user,
  company: `TEST Employer ${i}`,
  card_lines: [`TEST Employer ${i}`, ...Array.from({ length: lines - 2 }, (_, k) => `Question ${k}: answer ${i}.${k}`), `Sends to https://jobs.lever.co/test/${i}`],
  created_at: new Date(T - agoMin * 60000).toISOString(),
  ...more,
});
function pusher(result: (u: string) => string | null | Error = () => "C1") {
  const calls: { userId: string; ids: string[]; text: string }[] = [];
  return {
    calls,
    push: async (userId: string, ids: string[], text: string) => {
      calls.push({ userId, ids, text });
      const r = result(userId);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

Deno.test("WO-022/P1 a settled batch goes on one card, every line verbatim; a batch still being prepared waits", async () => {
  const p = pusher();
  const rows = [ready("A", 1, 30), ready("A", 2, 20), ready("A", 3, 12)];
  eq(await runCards({ now: T, ready: async () => rows, push: p.push }), 1);
  eq(p.calls.map((c) => c.ids), [["A-P1", "A-P2", "A-P3"]]);
  for (const r of rows) for (const l of r.card_lines) assert(p.calls[0].text.includes(l), "missing: " + l);
  const q = pusher();
  eq(await runCards({ now: T, ready: async () => [...rows, ready("A", 4, 3)], push: q.push }), 0);
  eq(q.calls.length, 0, "the newest is under 10 minutes old: the batch is not split across cards");
  assert(CARD_SETTLE_MS === 600000);
});

Deno.test("WO-022/P2 never in quiet hours (the person's, or 10pm to 7am New York when they set none)", async () => {
  const at3am = Date.parse("2026-10-20T07:00:00Z");
  const p = pusher();
  const rows = (tz?: string, qs?: number, qe?: number) => [
    { ...ready("A", 1, 0), created_at: new Date(at3am - 3600000).toISOString(), tz, quiet_start: qs, quiet_end: qe },
  ];
  eq(await runCards({ now: at3am, ready: async () => rows(), push: p.push }), 0, "3am New York by default");
  eq(await runCards({ now: at3am, ready: async () => rows("Asia/Tokyo"), push: p.push }), 1, "4pm in Tokyo");
  eq(await runCards({ now: at3am, ready: async () => rows("Asia/Tokyo", 15, 18), push: p.push }), 0, "their own quiet hours");
});

Deno.test("WO-022/P3 at most 8, one card per person per run, an application too long for a text never holds back the rest", async () => {
  const p = pusher();
  const many = Array.from({ length: 11 }, (_, i) => ready("A", i + 1, 60 - i));
  const other = [ready("B", 1, 15, 200), ready("B", 2, 14)];
  eq(await runCards({ now: T, ready: async () => [...many, ...other], push: p.push }), 2);
  eq(p.calls.map((c) => [c.userId, c.ids.length]), [["A", 8], ["B", 1]]);
  eq(p.calls[1].ids, ["B-P2"], "B's 200-line application is left for the app");
});

Deno.test("WO-022/P4 the database saying no is not a push; one person's failure does not stop the others and is recorded", async () => {
  const p = pusher((u) => (u === "B" ? null : u === "C" ? new Error("push a card: card text does not carry every line") : "C1"));
  let err = "";
  try {
    await runCards({ now: T, ready: async () => [ready("A", 1, 30), ready("B", 1, 30), ready("C", 1, 30), ready("D", 1, 30)], push: p.push });
  } catch (e) {
    err = (e as Error).message;
  }
  eq(p.calls.map((c) => c.userId), ["A", "B", "C", "D"]);
  assert(/card push failed for 1 people \(2 pushed\): push a card: card text does not carry every line/.test(err), err);
});

Deno.test("WO-022/P5 the scheduled run pushes cards and records how many; then one text yes approves the pushed card within 10 minutes, and not after", async () => {
  // A store that does what career_apply_card_push_for does: open the card and make it the thread's last word.
  let card: any = null, last: string | null = "agent";
  const approved: number[][] = [];
  const store: CardStore = {
    pending: async () => [],
    open: async () => card,
    latestOpen: async () => card,
    answer: async (_u, _c, a) => {
      approved.push(a);
      return card.items.map((i: any) => ({ n: i.n, company: `TEST Employer ${i.n}`, result: a.includes(i.n) ? "queued" : "declined" }));
    },
    lastAssistantIntent: async () => last,
    lastShownCard: async () => (last === CARD_INTENT ? card?.id ?? null : null),
    cardOfMessage: async (_t, id) => (card && String(id) === `M-${card.id}` ? card.id : null),
  };
  const runs: any[] = [];
  const res = await handleProactive(
    new Request("https://fn.test/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": "z".repeat(40) } }),
    {
      env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? "z".repeat(40) : undefined) },
      store: () => memoryAlertStore(),
      now: () => T,
      recentPostings: async () => [],
      postingsById: async () => [],
      readyApplications: async () => [ready("A", 1, 30), ready("A", 2, 30), ready("A", 3, 30)],
      pushCard: async (_u, ids) => {
        card = { id: "C1", items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: "h" })), shown_at: new Date(T).toISOString() };
        last = CARD_INTENT;
        return "C1";
      },
      recordRun: async (r: any) => {
        runs.push(r);
      },
    },
  );
  eq(res.status, 200);
  eq(runs.map((r) => [r.cards, r.error]), [[1, null]]);
  const other = await cardTurn({ message: "yes but not 2", userId: "A", threadId: "TH", now: T + 60000, store, replyTo: "M-other" });
  eq(other?.status, "needs_reply", "a yes quoting some other message is not about the card: nothing approved");
  eq(approved, []);
  // D-MS-1 (2026-10-27): the plain yes right after the pushed card (no reply id: iMessage, SMS) approves it.
  const out = await cardTurn({ message: "yes but not 2", userId: "A", threadId: "TH", now: T + 60000, store });
  eq(out?.status, "answered", "SERIAL-1440 (1) / D-MS-1: one text yes to the pushed card approves the batch it names, within 10 minutes");
  eq(approved, [[1, 3]], "exactly 1 and 3");
  card = { ...card, shown_at: new Date(T).toISOString() };
  const late = await cardTurn({ message: "yes", userId: "A", threadId: "TH", now: T + 11 * 60000, store, replyTo: "M-C1" });
  eq(late?.status, "stale_card", "11 minutes after the card: nothing approved");
  eq(approved, [[1, 3]]);
});
