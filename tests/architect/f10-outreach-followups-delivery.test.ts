// FEATURE 10 follow-up (PR #214): the follow-up reminder's road to delivery, proven up to the outbox —
// the last hop this repo can prove without deploying career-proactive / trainee-deliver.
// (1) The gate: with CAREER_OUTREACH_FOLLOWUPS off (the default) a due reminder queues NOTHING; with it on,
//     exactly one outbox row is queued, key 'followup:outreach:<draft id>', kind 'followup', text naming the
//     person and the subject, and the reminder is marked fired so it never queues twice.
// (2) The consumer contract: the delivery run (channel.ts deliverDue, the code trainee-deliver serves) takes
//     a claimed outbox row of exactly the queued shape — the claim RPC (career_outbox_claim) resolves the
//     person's channel contact and filters on nothing but due-ness — and delivers the text verbatim, once;
//     a person who said STOP is skipped, never sent to. In-memory stores throughout; nothing is sent.
// Run: deno test -A --no-check tests/architect/f10-outreach-followups-delivery.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
import { memoryOutreachStore, messageOf, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { runOutreachFollowupsGated } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { deliverDue, memoryChannel } from "../../supabase/functions/_shared/channel.ts";

const U = "u-1", DAY = 86400000, T0 = Date.parse("2026-10-20T15:00:00Z"), DUE = T0 + 7 * DAY;

async function accountWithDueReminder() {
  const store = memoryOutreachStore();
  const d: any = { n: 1, recipient: { name: "Maya Chen", firm: "Stripe", title: "", school: "", email: "maya@stripe.example", source: "x" }, subject: "Intro and a question", body: "Hi Maya, a short note.", footer: "", status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(T0).toISOString(), hash: "", shared: [] };
  d.hash = await payloadHash(messageOf(d));
  const [saved] = await store.saveBatch(U, "t-1", [d], T0);
  await store.update(U, { ...saved, status: "sent", sent_at: new Date(T0).toISOString(), result: "sent_by_you" }, {});
  await store.saveFollowups!(U, [{ draft_id: saved.id, name: "Maya Chen", firm: "Stripe", email: "maya@stripe.example", subject: "Intro and a question", sent_at: new Date(T0).toISOString(), due_at: new Date(DUE).toISOString(), set_at: new Date(T0).toISOString(), fired_at: null, asked: false }]);
  return { store, id: saved.id };
}
// D-036: CAREER_OUTREACH_FOLLOWUPS is a release flag (on when unset); "off" is its rollback.
const env = (on: boolean) => ({ get: (k: string) => (k === "CAREER_OUTREACH_FOLLOWUPS" ? (on ? "on" : "off") : undefined) });

Deno.test("followup gate: off queues nothing however much is due; on queues one row of the right key, kind and text", async () => {
  const { store, id } = await accountWithDueReminder();
  const offBox = memoryAlertStore();
  const off = await runOutreachFollowupsGated(env(false), { store, outbox: offBox, now: DUE + 1 });
  assertEquals(off, undefined, "flag off: the follow-up run does not happen");
  assertEquals(offBox.dump().outbox.length, 0, "flag off: nothing is queued");
  assertEquals((await store.followups!(U))[0].fired_at, null, "flag off: the reminder is not marked fired");

  const onBox = memoryAlertStore();
  const on = await runOutreachFollowupsGated(env(true), { store, outbox: onBox, now: DUE + 1 });
  assertEquals([on!.due, on!.queued], [1, 1]);
  const rows = onBox.dump().outbox;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].userId, U);
  assertEquals(rows[0].key, `followup:outreach:${id}`);
  assertEquals(rows[0].kind, "followup");
  assertMatch(rows[0].text, /Follow-up reminder: you emailed Maya Chen \(Stripe\) on Oct 20 \("Intro and a question"\)/);
  assertEquals(rows[0].at, DUE + 1, "queued for immediate delivery at the run's now");
  assert((await store.followups!(U))[0].fired_at !== null, "the reminder is marked fired once queued");
  const again = await runOutreachFollowupsGated(env(true), { store, outbox: onBox, now: DUE + 2 });
  assertEquals([again!.due, again!.queued], [0, 0], "a fired reminder never queues twice");
  assertEquals(onBox.dump().outbox.length, 1);
});

Deno.test("followup delivery contract: the consumer delivers a claimed row of the queued shape verbatim, once; STOP holds it", async () => {
  const { store, id } = await accountWithDueReminder();
  const box = memoryAlertStore();
  await runOutreachFollowupsGated(env(true), { store, outbox: box, now: DUE + 1 });
  const queued = box.dump().outbox[0];
  assertEquals(queued.key, `followup:outreach:${id}`);

  // The claim (career_outbox_claim) hands the consumer the row with the person's channel contact resolved;
  // that claimed shape is what deliverDue consumes.
  const claimed = { id: "1", userId: queued.userId, contact: "+15550001111", key: queued.key, text: queued.text, deliver_at: queued.at, attempts: 0 };
  const sent: { contact: string; bubbles: string[] }[] = [];
  const send = async (contact: string, bubbles: string[]) => { sent.push({ contact, bubbles }); return { ok: true as const, id: "lm-1" }; };
  const ch = memoryChannel();
  ch.queue(claimed);
  const r = await deliverDue({ store: ch, send, now: DUE + 2000 });
  assertEquals(r.delivered, 1);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].contact, "+15550001111");
  assertEquals(sent[0].bubbles.join(""), queued.text, "the reminder text goes out verbatim");
  assertEquals(ch.rows()[0].status, "delivered");
  const again = await deliverDue({ store: ch, send, now: DUE + 3000 });
  assertEquals(again.delivered, 0, "a delivered reminder is never sent twice");

  // A person who opted out: the row is held as skipped_opt_out and the sender is never called.
  const ch2 = memoryChannel();
  await ch2.setOptOut("+15550001111", true);
  ch2.queue({ ...claimed, id: "2" });
  const r2 = await deliverDue({ store: ch2, send, now: DUE + 2000 });
  assertEquals([r2.delivered, r2.skipped_opt_out], [0, 1]);
  assertEquals(sent.length, 1, "nothing more was sent");
  assertEquals(ch2.rows()[0].status, "skipped_opt_out");
});
