// SERIAL-1500 (3) / SERIAL-1501: BATCH_MAX (10) is a display page, not a scope cap. A long list is drafted and approved
// ten at a time; every page's approvals stand, the send run reads approvals (not the page), and nothing about paging
// cuts what the person approved. NO LIMITS (owner, 2026-10-27): Trainee sets no volume number of its own, so there is
// no warm-up, no daily number and no spacing: everything approved goes in one run. What stays and is observed here:
// exact per-message approval (a changed draft is refused), Gmail's own refusal (RATE_LIMITED) is the only thing that
// slows a person, and the 7-day approval expiry. No real send: a fake sender records what would have gone.
import assertNode from "node:assert/strict";
import {
  admitSend, APPROVAL_TTL_MS, BATCH_MAX, memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, type OutreachDraft, outreachTurn,
  payloadHash, runOutreachSends, type Sender,
} from "../../supabase/functions/_shared/career_outreach.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "TEST-PAGES", TH = "TEST-PAGES-THREAD", DAY = 86_400_000;
const T0 = Date.parse("2026-10-14T15:00:00Z"); // 11:00 in New York; days advance at the same hour

async function page(store: ReturnType<typeof memoryOutreachStore>, k: number, at: number) {
  const ds: any[] = [];
  for (let n = 1; n <= BATCH_MAX; n++) {
    const i = (k - 1) * BATCH_MAX + n;
    const d: any = { n, recipient: { name: `Banker ${i} Synthetic`, firm: `Firm ${(i % 7) + 1}`, title: "Analyst", school: "", email: `banker${i}@firm${(i % 7) + 1}.example`, source: `list.csv, row ${i}` },
      subject: `Question about your path, ${i}`, body: `Hi, body ${i}.`, footer: `Sam Student\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(at).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  const saved = await store.saveBatch(U, TH, ds, at);
  store.setIntent(TH, OUTREACH_INTENT);
  return saved;
}
function fakeSender(o: { refuseAfter?: number } = {}): Sender & { sent: string[]; refused: number; open: () => void } {
  const sent: string[] = [];
  let gate = o.refuseAfter ?? Infinity;
  const me = { sent, refused: 0, open: () => { gate = Infinity; },
    async send(_u: string, m: { to: string }) {
      // Gmail's own per-account ceiling, faked: past it, 429 (RATE_LIMITED) until it opens again.
      if (sent.length >= gate) { me.refused++; return { status: "RATE_LIMITED" as const, detail: "HTTP 429 userRateLimitExceeded" }; }
      sent.push(m.to); return { status: "sent" as const, id: `g${sent.length}`, thread_id: `t${sent.length}` };
    } };
  return me;
}
const approvedCount = (store: any) => store.dump().drafts.filter((d: OutreachDraft) => d.status === "approved").length;

Deno.test("five pages of ten, each approved as shown: fifty approvals stand; one run sends all fifty, no warm-up, daily number or spacing", async () => {
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Sam Student" });
  for (let k = 1; k <= 5; k++) {
    await page(store, k, T0 + k * 60_000);
    const r = await outreachTurn({ message: "send all", userId: U, threadId: TH, now: T0 + k * 60_000 + 5_000, store, gmailConnected: async () => true });
    eq(r?.status, "approved", r?.reply);
    assert(/Approved 10, exactly as shown/.test(r!.reply), r!.reply);
    eq(approvedCount(store), k * BATCH_MAX, `page ${k}: every earlier page's approvals stand`);
  }
  // The page is a display: "show my drafts" shows the newest ten; the approvals are fifty.
  eq((await store.latestBatch(U)).length, BATCH_MAX);
  eq((await store.approvedDue(500)).length, 50, "the send run reads approvals, not the page");
  eq((await store.contacted(U)).size, 50, "the next page never repeats anyone already drafted");
  // Exact per-message approval: each approved hash is the message shown; a changed message is refused.
  const all = store.dump().drafts as OutreachDraft[];
  for (const d of all) eq(d.approved_hash, d.hash, `${d.recipient.email} approved exactly as shown`);
  const one = all[0], changed = { ...one, body: one.body + " and one more line" };
  eq(admitSend({ draft: changed, hash: await payloadHash(messageOf(changed)), now: T0 + DAY, dnc: false }), "changed");
  // A brand-new sender (no history), fifty approved: one run, all fifty, each once.
  const sender = fakeSender();
  const r = await runOutreachSends({ store, sender, now: T0 + DAY, tz: async () => "America/New_York" });
  eq(r.sent, 50, `one run sends everything approved: ${JSON.stringify(r)}`);
  eq(Object.keys(r.refused), [], "nothing refused for volume (no daily_cap, spacing or warm-up)");
  eq(new Set(sender.sent).size, 50, "each once");
  eq((await runOutreachSends({ store, sender, now: T0 + DAY + 1000 })).sent, 0, "a second run sends nothing again");
  eq(store.dump().drafts.filter((d: OutreachDraft) => d.status === "sent").length, 50);
});

Deno.test("only Gmail slows it: past Gmail's own ceiling (429) the rest wait, approved and unsent; they go when Gmail allows; the 7-day expiry still holds", async () => {
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Sam Student" });
  for (let k = 1; k <= 10; k++) {
    await page(store, k, T0 + k * 60_000);
    eq((await outreachTurn({ message: "send all", userId: U, threadId: TH, now: T0 + k * 60_000 + 5_000, store, gmailConnected: async () => true }))?.status, "approved");
  }
  eq(approvedCount(store), 100, "a hundred approved at once, ten pages");
  const sender = fakeSender({ refuseAfter: 70 });
  const first = await runOutreachSends({ store, sender, now: T0 + DAY });
  eq([first.sent, first.rate_limited], [70, 1], "70 go; Gmail's 429 stops this person's run at once (one refusal, no tight retry loop)");
  eq(sender.refused, 1);
  eq(approvedCount(store), 30, "the other 30 stay approved, waiting on Gmail, never dropped or doubled");
  assert((store.dump().drafts as OutreachDraft[]).some((d) => d.result === "rate_limited"), "the refusal is recorded on the draft");
  sender.open();
  const later = await runOutreachSends({ store, sender, now: T0 + DAY + 3600_000 });
  eq(later.sent, 30, "when Gmail allows, the rest go");
  eq([sender.sent.length, new Set(sender.sent).size], [100, 100], "all hundred, each once");
  // The approval's 7-day life is not a volume number and stays: approvals Gmail never took in 7 days lapse.
  const store2 = memoryOutreachStore();
  await store2.setPrefs(U, { signature: "Sam Student" });
  await page(store2, 1, T0);
  await outreachTurn({ message: "send all", userId: U, threadId: TH, now: T0 + 5_000, store: store2, gmailConnected: async () => true });
  const shut = fakeSender({ refuseAfter: 0 });
  eq((await runOutreachSends({ store: store2, sender: shut, now: T0 + DAY })).sent, 0);
  const late = await runOutreachSends({ store: store2, sender: fakeSender(), now: T0 + 8 * DAY });
  eq([late.sent, late.refused.expired], [0, BATCH_MAX], "past 7 days they lapse unsent and need approving again");
  eq(APPROVAL_TTL_MS, 7 * DAY);
});
