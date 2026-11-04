// SERIAL-1510: approval expiry is disclosed, never silent, and never extended. (a) The approval reply promises no pace of
// Trainee's own (NO LIMITS) and says any not sent within 7 days lapse unsent (what holds them back is Gmail refusing). (b) When approvals lapse, the next "show my drafts"
// says how many and offers "show lapsed", which shows exactly the unsent drafts again as a fresh batch for a fresh
// approval; the old approval is dead and never implied valid. (c) No extension, no auto-renew: APPROVAL_TTL_MS and
// BATCH_TTL_MS unchanged. No sends: a fake sender records what would have gone.
import assertNode from "node:assert/strict";
import {
  APPROVAL_TTL_MS, BATCH_MAX, BATCH_TTL_MS, memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, type OutreachDraft, outreachTurn, parseOutreachReply,
  payloadHash, runOutreachSends, type Sender,
} from "../../supabase/functions/_shared/career_outreach.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "TEST-LAPSE", TH = "TEST-LAPSE-THREAD", DAY = 86_400_000;
const T0 = Date.parse("2026-10-14T15:00:00Z");

async function page(store: ReturnType<typeof memoryOutreachStore>, k: number, at: number) {
  const ds: any[] = [];
  for (let n = 1; n <= BATCH_MAX; n++) {
    const i = (k - 1) * BATCH_MAX + n;
    const d: any = { n, recipient: { name: `Banker ${i} Synthetic`, firm: `Firm ${(i % 5) + 1}`, title: "Analyst", school: "", email: `lapse${i}@firm${(i % 5) + 1}.example`, source: `list.csv, row ${i}` },
      subject: `Question about your path, ${i}`, body: `Hi, body ${i}.`, footer: `Sam Student\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(at).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  const saved = await store.saveBatch(U, TH, ds, at);
  store.setIntent(TH, OUTREACH_INTENT);
  return saved;
}
// Gmail's own ceiling, faked: past `gate` sends it answers 429 (RATE_LIMITED) until opened.
function fakeSender(gate = Infinity): Sender & { sent: string[]; open: () => void } {
  const sent: string[] = [];
  return { sent, open() { gate = Infinity; }, async send(_u, m) {
    if (sent.length >= gate) return { status: "RATE_LIMITED", detail: "HTTP 429 userRateLimitExceeded" };
    sent.push(m.to); return { status: "sent", id: `g${sent.length}`, thread_id: `t${sent.length}` };
  } };
}
// One scheduled run a day (one run sends everything it can: there is no pace of Trainee's own).
async function runDay(store: any, sender: Sender, at: number) {
  return (await runOutreachSends({ store, sender, now: at, tz: async () => "America/New_York" })).sent;
}
const say = (store: any, message: string, now: number) => outreachTurn({ message, userId: U, threadId: TH, now, store, gmailConnected: async () => true });

Deno.test("(a) the approval reply states no pace of Trainee's own, says that unsent approvals lapse after 7 days; (c) the windows are unchanged", async () => {
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Sam Student" });
  await page(store, 1, T0);
  const r = (await say(store, "send all", T0 + 1000))!;
  eq(r.status, "approved");
  // NO LIMITS (owner, 2026-10-27): no pace or daily number of Trainee's own is promised; only Gmail's refusal slows sending.
  assert(!/a day|seconds apart|first week/.test(r.reply), r.reply);
  assert(/If Gmail asks to slow down, the rest wait and go on when it allows, and I'll tell you\. Any not sent within 7 days of your approval lapse unsent; when you next ask I'll say how many, and you can approve them again\./.test(r.reply), r.reply);
  eq(APPROVAL_TTL_MS, 7 * DAY, "no extension");
  eq(BATCH_TTL_MS, 72 * 3600_000, "no extension");
  eq(parseOutreachReply("show lapsed"), { kind: "lapsed" });
  eq(parseOutreachReply("show me the lapsed drafts"), { kind: "lapsed" });
  eq(parseOutreachReply("re-show the unsent drafts"), { kind: "lapsed" });
  eq(parseOutreachReply("show my drafts"), { kind: "show" });
});

Deno.test("(b) lapsed approvals are said on the next ask, never proactively; 'show lapsed' re-shows exactly the unsent drafts for a fresh approval; the old approval stays dead", async () => {
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Sam Student" });
  for (let k = 1; k <= 10; k++) { await page(store, k, T0 + k * 60_000); eq((await say(store, "send all", T0 + k * 60_000 + 5_000))?.status, "approved"); }
  const sender = fakeSender(65);
  for (let d = 1; d <= 8; d++) await runDay(store, sender, T0 + d * DAY);
  // 100 approved at T0; day 1 sends 65 and then Gmail refuses this account for the rest of the week; the window closes
  // on day 7, so the rest lapse.
  const sent = sender.sent.length;
  eq(sent, 65, `Gmail took 65, then refused: ${sent} sent`);
  const lapsedRows = (store.dump().drafts as OutreachDraft[]).filter((d) => d.status === "skipped" && d.result === "expired");
  eq(lapsedRows.length, 100 - sent);
  for (const d of lapsedRows) eq(d.approved_hash, null, "the lapsed approval is cleared on the row");
  // Nothing was texted about it: the run returned its stats and wrote the rows; the disclosure waits for the next ask.
  const asked = (await say(store, "show my drafts", T0 + 9 * DAY))!;
  eq(asked.status, "shown_lapsed");
  assert(new RegExp(`^${100 - sent} approved drafts lapsed unsent: approved more than 7 days ago, not sent by then, and that approval is no longer valid\\. Say "show lapsed" to see exactly those drafts again for a fresh approval\\.`).test(asked.reply), asked.reply);
  assert(asked.parts?.[0]?.startsWith(`${100 - sent} approved drafts lapsed`), "the lapsed line is its own message part");
  // Re-show: a fresh batch of exactly the unsent drafts, same recipients and words, nothing approved.
  const again = (await say(store, "show lapsed", T0 + 9 * DAY + 60_000))!;
  eq([again.status, again.intent], ["lapsed_shown", OUTREACH_INTENT]);
  assert(new RegExp(`^${100 - sent} drafts lapsed unsent; here they are again, exactly as before\\. The earlier approval no longer counts: nothing is sent until you approve them again\\.`).test(again.reply), again.reply);
  const shown = await store.latestBatch(U);
  eq(shown.length, 100 - sent);
  eq(shown.map((d) => d.recipient.email).sort(), lapsedRows.map((d) => d.recipient.email).sort(), "exactly the unsent drafts");
  for (const d of shown) { eq([d.status, d.approved_hash], ["shown", null]); const old = lapsedRows.find((x) => x.recipient.email === d.recipient.email)!; eq([d.subject, d.body, d.hash], [old.subject, old.body, old.hash], "the same words"); }
  // The old rows stay dead: skipped, no approval, marked as re-shown so they are not offered twice; the run sends nothing.
  for (const d of (store.dump().drafts as OutreachDraft[]).filter((x) => lapsedRows.some((l) => l.id === x.id))) eq([d.status, d.approved_hash, d.result], ["skipped", null, "expired_reshown"]);
  eq(await runDay(store, sender, T0 + 10 * DAY), 0, "nothing goes from a lapsed approval or an unapproved re-show");
  eq((await say(store, "show my drafts", T0 + 10 * DAY + 1000))?.status, "shown", "once re-shown, the lapsed line is not repeated");
  eq((await say(store, "show lapsed", T0 + 10 * DAY + 2000))?.status, "none_lapsed");
  // Only a fresh "send" approves them again, and then they all go as soon as Gmail allows.
  store.setIntent(TH, OUTREACH_INTENT);
  const fresh = (await say(store, "send all", T0 + 10 * DAY + 3000))!;
  eq(fresh.status, "approved");
  assert(new RegExp(`Approved ${100 - sent}, exactly as shown`).test(fresh.reply), fresh.reply);
  eq(await runDay(store, sender, T0 + 11 * DAY), 0, "while Gmail still refuses, nothing goes and nothing is lost");
  sender.open();
  const day12 = await runDay(store, sender, T0 + 12 * DAY);
  eq(day12, 100 - sent, `Gmail allows again: all ${100 - sent} in one run, no number of Trainee's own: ${day12}`);
  eq(sender.sent.length, 100, "every draft went exactly once in the end, each under its own fresh approval");
  eq(new Set(sender.sent).size, 100);
});
