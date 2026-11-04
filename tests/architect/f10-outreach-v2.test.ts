// Outreach v2 (lane N2, 2026-10-27): the review items on PR #214 and the owner's decisions of that evening, each proven on
// state (store rows, outbox rows, the exact URL built), in-memory, synthetic data, no network and no model call.
//   M  the mailto link: a recipient address carrying CRLF, extra recipients, cc/bcc or a query never adds a header,
//      a recipient or a parameter (the `to` guard, which no test caught before: review item 3);
//   L  LinkedIn: every action asked on it (message, connect, endorse, post, comment, follow, apply, Easy Apply, anything
//      "via LinkedIn") is refused plainly, never a draft to "maya via LinkedIn"; their own export is not refused;
//   R  reminders (ruling R2): the reply promises a texted reminder only when the push is on AND they have a channel;
//      otherwise it says plainly no message comes and where the follow-up shows;
//   B  D-MN-2: one yes approves exactly the batch shown, each draft bound to its own hash, handed to the sending rail as
//      {draftId, approvalHash}; subsets approve what is stated; hedged answers approve nothing; a changed draft is refused;
//   S  scale: the reminder run claims people in leased batches until none is due (no "first 500"), oldest due first,
//      two runs never claim the same person, and reads only the drafts the reminders are about.
// Run: deno test -A --no-check tests/architect/f10-outreach-v2.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
import * as CO from "../../supabase/functions/_shared/career_outreach.ts";
import * as CT from "../../supabase/functions/_shared/career_outreach_track.ts";
import { networkingTurn, parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";
const { memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, outreachTurn, payloadHash } = CO;

const U = "u-n2", TH = "t-n2", T0 = Date.parse("2026-10-27T15:00:00Z"), DAY = 86_400_000;
async function batch(store: ReturnType<typeof memoryOutreachStore>, n: number, at = T0, user = U) {
  const ds: any[] = [];
  for (let k = 1; k <= n; k++) {
    const d: any = { n: k, recipient: { name: `Person ${k} Test`, firm: "Stripe", title: "", school: "", email: `p${k}@stripe.example`, source: "list.csv" }, subject: `Question ${k}`,
      body: `Hi, note ${k}.`, footer: `Jordan\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null,
      created_at: new Date(at).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  const saved = await store.saveBatch(user, TH, ds, at);
  store.setIntent(TH, OUTREACH_INTENT);
  return saved;
}

// ------------------------------------------------------------------------------------------------ M
Deno.test("M mailto: an address with CRLF, extra recipients, cc/bcc or a query adds no header, recipient or parameter", () => {
  const mailtoOf = (CO as any).mailtoOf as (m: CO.Message) => { url: string };
  for (const to of ["maya@stripe.example\r\nBcc: evil@x.example", "maya@stripe.example?cc=evil@x.example", "maya@stripe.example&bcc=evil@x.example",
    "maya@stripe.example,evil@x.example", "maya@stripe.example;evil@x.example", "maya@stripe.example%0D%0ABcc:evil@x.example", "<maya@stripe.example>?body=hi", "maya@stripe.example#x"]) {
    const url = mailtoOf({ to, subject: "Hi", text: "Body" }).url;
    const u = new URL(url);
    eq([...u.searchParams.keys()], ["subject", "body"], `${JSON.stringify(to)} -> ${url}`);
    eq([u.searchParams.get("subject"), u.searchParams.get("body")], ["Hi", "Body"], url);
    assert(!/[\r\n]/.test(url) && !/[?&](?:cc|bcc|to)=/i.test(url), url);
    // The path is one opaque, percent-encoded address: no raw separator a mail app could split on.
    assert(!/[,;?&#\s<>]/.test(decodeURIComponent(u.pathname) === to ? u.pathname : u.pathname.replace(/%[0-9A-F]{2}/gi, "")), url);
    eq(decodeURIComponent(u.pathname), to, "the address is carried exactly, never rewritten into another recipient");
  }
  // Subject and body injection stays inside their own parameter.
  const u = new URL(mailtoOf({ to: "maya@stripe.example", subject: "Hi\r\nBcc: evil@x.example", text: "a&bcc=evil@x.example\r\nb" }).url);
  eq([...u.searchParams.keys()], ["subject", "body"]);
  eq(u.searchParams.get("subject"), "Hi\r\nBcc: evil@x.example");
  eq(u.searchParams.get("body"), "a&bcc=evil@x.example\r\nb");
  eq(decodeURIComponent(u.pathname), "maya@stripe.example");
});

// ------------------------------------------------------------------------------------------------ L
const say = (store: any, message: string, state: Record<string, unknown> = {}) => networkingTurn({ message, userId: U, threadId: TH, now: T0, state, store, model: null });
Deno.test("L LinkedIn: every action on it is refused plainly, in messy phrasings; never a draft to 'maya via LinkedIn'", async () => {
  const store = memoryOutreachStore();
  const state = { contacts: [{ file: "c.csv", row: 1, name: "Maya Chen", email: "maya@stripe.example", firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "", school: "", connected_on: null, verified: true }] };
  const asks = ["reach out to maya via LinkedIn", "Reach out to Maya through linkedin pls", "message maya on linkedin", "can u connect with maya on linked in",
    "endorse maya on linkedin", "endorse maya for sql on LinkedIn", "post this on linkedin", "share my resume on linkedin", "comment on maya's linkedin post",
    "like maya's post on linkedin", "follow stripe on linkedin", "apply on linkedin for me", "apply to the stripe job on linkedin", "Easy Apply to the stripe job on linkedin",
    "easy apply to all of them", "email maya via linkedin", "write to maya via LinkedIn about coffee", "ping lee on LinkedIn", "send maya an inmail"];
  for (const m of asks) {
    eq(parseNetworkingAsk(m)?.kind === "draft" && /linked/i.test((parseNetworkingAsk(m) as any).target?.name ?? "") ? "named LinkedIn" : "ok", "ok", m);
    const r = await say(store, m, structuredClone(state));
    eq([r?.intent, r?.status], [CT.LINKEDIN_INTENT, "refused"], `${m}: ${r?.reply}`);
    assert(/Nothing was sent or done on LinkedIn\./.test(r!.reply) && !/via LinkedIn is in your contacts|No one named/.test(r!.reply), r!.reply);
  }
  eq(store.dump().drafts, [], "nothing drafted or recorded");
  // Applying names the way in instead; reaching a contact offers the email instead.
  assert(/I don't apply on LinkedIn for you \(Easy Apply included\)/.test((await say(store, "apply on linkedin for me"))!.reply));
  assert(/I can write Maya an email instead, for you to approve: Maya Chen at Stripe/.test((await say(store, "reach out to maya via LinkedIn", structuredClone(state)))!.reply));
  // Their own export, and plain asks that mention LinkedIn without an action on it, are not refused.
  for (const m of ["how do I download my linkedin connections", "here are my linkedin connections", "who do I know at stripe from linkedin",
    "follow up with maya who I met on linkedin", "I'd like to email maya at stripe"]) {
    const r = await say(store, m, structuredClone(state));
    assert(r?.intent !== CT.LINKEDIN_INTENT, `${m}: ${r?.reply}`);
  }
});

// ------------------------------------------------------------------------------------------------ R
async function sentDraft() {
  const store = memoryOutreachStore();
  const [d] = await batch(store, 1);
  await store.update(U, { ...d, status: "approved", approved_hash: d.hash, approved_at: new Date(T0).toISOString() }, {});
  store.setIntent(TH, null);
  return store;
}
const track = (store: any, message: string, extra: Partial<CT.TrackDeps> = {}) =>
  CT.trackTurn({ message, userId: U, threadId: TH, now: T0, store, facts: [], model: null, ...extra });
Deno.test("R reminders: a texted reminder is promised only when the push is on and a channel is linked; otherwise said plainly", async () => {
  for (const [label, extra, re] of [
    ["flag off", { reminderPush: false, textingChannel: async () => "telegram" }, /I won't message you a reminder: follow-up reminders aren't switched on yet\. From \w{3}, \w{3} \d{1,2}, "who have I reached out to" shows this follow-up as due\./],
    ["flag on, web only", { reminderPush: true, textingChannel: async () => null }, /I won't message you a reminder: no texting channel \(iMessage\/SMS, WhatsApp or Telegram\) is linked to your account\./],
    ["flag on, channel unreadable", { reminderPush: true, textingChannel: async () => { throw new Error("down"); } }, /I won't message you a reminder: no texting channel/],
    ["flag on, Telegram", { reminderPush: true, textingChannel: async () => "telegram" }, /I'll text you a reminder on Telegram on \w{3}, \w{3} \d{1,2} to follow up if there's no reply by then\./],
    ["flag on, iMessage", { reminderPush: true, textingChannel: async () => "imessage" }, /I'll text you a reminder on iMessage\/SMS on/],
  ] as const) {
    const store = await sentDraft();
    const r = await track(store, "sent 1", extra);
    eq(r!.status, "marked_sent", `${label}: ${r!.reply}`);
    assert(re.test(r!.reply), `${label}: ${r!.reply}`);
    if (!/text you/.test(String(re))) assert(!/I'll (?:text|remind) you/.test(r!.reply), `${label}: no promise: ${r!.reply}`);
    // The reminder record is kept either way: the list shows it, and the run (when on) queues it.
    eq((await store.followups!(U)).length, 1, label);
    const again = await track(store, "remind me to follow up with person in 3 days", extra);
    eq(again!.status, "reminder_set", again!.reply);
    if (/text you/.test(String(re))) assert(/^I'll text you a reminder on \w{3}, \w{3} \d{1,2} to follow up with Person 1 Test/.test(again!.reply), again!.reply);
    else assert(/^Follow-up with Person 1 Test \(Stripe\) set for \w{3}, \w{3} \d{1,2}\. I won't message you a reminder/.test(again!.reply), again!.reply);
  }
  // The ladder after an approval promises no reminder at all.
  const store = memoryOutreachStore();
  await batch(store, 1);
  const ok = await outreachTurn({ message: "send 1", userId: U, threadId: TH, now: T0 + 1000, store, gmailConnected: async () => false });
  assert(!/remind you/.test(ok!.reply) && /set a follow-up for 7 days later/.test(ok!.reply), ok!.reply);
});

// ------------------------------------------------------------------------------------------------ B
Deno.test("B one yes approves exactly the batch shown, each bound to its own hash, handed to the sending rail once", async () => {
  const store = memoryOutreachStore();
  const shown = await batch(store, 300);
  const handed: { userId: string; items: CO.ApprovedItem[] }[] = [];
  const onApproved = async (userId: string, items: CO.ApprovedItem[]) => { handed.push({ userId, items }); };
  const r = await outreachTurn({ message: "yes, send them all", userId: U, threadId: TH, now: T0 + 1000, store, gmailConnected: async () => true, onApproved });
  eq(r!.status, "approved", r!.reply);
  assert(/^Approved 300, exactly as shown/.test(r!.reply), r!.reply.slice(0, 200));
  const rows = store.dump().drafts;
  eq(rows.filter((d) => d.status === "approved").length, 300);
  for (const d of rows) eq(d.approved_hash, await payloadHash(messageOf(d)), `draft ${d.n} bound to its own exact message`);
  eq(handed.length, 1, "one hand-off for the whole batch");
  eq(handed[0].items.map((x) => [x.draftId, x.approvalHash, x.n]), shown.map((d) => [d.id, d.hash, d.n]));
  eq(r!.approved, handed[0].items);
  eq((await CO.approvedOutreach(store, U)).map((x) => x.draftId), rows.map((d) => d.id).reverse().sort((a, z) => Number(z.slice(1)) - Number(a.slice(1))).map(String).sort((a, z) => Number(z.slice(1)) - Number(a.slice(1))));
});

Deno.test("B subsets approve only what is stated; hedged answers approve nothing; a changed draft is refused; only on the batch's turn", async () => {
  const cases: [string, number[] | "bad" | null][] = [
    ["yes", [1, 2, 3, 4, 5]], ["Yes!", [1, 2, 3, 4, 5]], ["ok send them", [1, 2, 3, 4, 5]], ["looks good, send them all", [1, 2, 3, 4, 5]],
    ["yes except 3", [1, 2, 4, 5]], ["yes but not 2, 4", [1, 3, 5]], ["yes except 2-4", [1, 5]], ["only 1,2", [1, 2]], ["just 5", [5]], ["yes only 3-4", [3, 4]],
    ["maybe", null], ["yes?", null], ["yes but not Acme", "bad"], ["yes except the recruiter", "bad"], ["hmm not sure", null], ["yes except 9", "bad"],
  ];
  for (const [msg, want] of cases) {
    const store = memoryOutreachStore();
    await batch(store, 5);
    const r = await outreachTurn({ message: msg, userId: U, threadId: TH, now: T0 + 1000, store, gmailConnected: async () => true });
    const approved = store.dump().drafts.filter((d) => d.status === "approved").map((d) => d.n);
    if (want === null) { eq(r, null, `${msg}: not an answer to the batch`); eq(approved, [], msg); continue; }
    if (want === "bad") { eq(approved, [], `${msg}: approves nothing: ${r?.reply}`); assert(r && /Nothing was approved|there is no/.test(r.reply), `${msg}: ${r?.reply}`); continue; }
    eq(approved, want, `${msg}: ${r?.reply}`);
  }
  // A bare "yes" when the batch is not the thread's last word is someone else's.
  const other = memoryOutreachStore();
  await batch(other, 3);
  other.setIntent(TH, "career_apply_card");
  eq(await outreachTurn({ message: "yes", userId: U, threadId: TH, now: T0 + 1000, store: other }), null);
  eq(other.dump().drafts.filter((d) => d.status === "approved").length, 0);
  // A draft whose text changed after it was shown is refused; the rest of the yes stands.
  const changed = memoryOutreachStore();
  const [a] = await batch(changed, 3);
  await changed.update(U, { ...a, body: "Hi, something else entirely." }, {});
  const r = await outreachTurn({ message: "yes", userId: U, threadId: TH, now: T0 + 1000, store: changed, gmailConnected: async () => true });
  assert(/Not approved: 1 \(changed since it was shown\)/.test(r!.reply), r!.reply);
  eq(changed.dump().drafts.filter((d) => d.status === "approved").map((d) => d.n), [2, 3]);
  eq(r!.approved!.map((x) => x.n), [2, 3]);
});

// ------------------------------------------------------------------------------------------------ S
async function dueFor(store: ReturnType<typeof memoryOutreachStore>, user: string, dueAt: number) {
  const [d] = await batch(store, 1, T0, user);
  await store.update(user, { ...d, status: "sent", sent_at: new Date(T0).toISOString(), result: "sent_by_you" }, {});
  await store.saveFollowups!(user, [{ draft_id: d.id, name: "Person 1 Test", firm: "Stripe", email: d.recipient.email, subject: d.subject, sent_at: new Date(T0).toISOString(),
    due_at: new Date(dueAt).toISOString(), set_at: new Date(T0).toISOString(), fired_at: null, asked: false }]);
}
Deno.test("S the reminder run claims leased batches until none is due: 1,200 people, batch 50, every one fired once, oldest first", async () => {
  const store = memoryOutreachStore();
  const N = 1200;
  for (let i = 0; i < N; i++) await dueFor(store, `u${String(i).padStart(5, "0")}`, T0 + 7 * DAY - i * 1000);
  const queued: { u: string; key: string }[] = [];
  const outbox = { enqueue: async (u: string, m: any) => { if (queued.some((x) => x.key === m.key)) return false; queued.push({ u, key: m.key }); return true; } };
  let historyReads = 0;
  const counted = { ...store, history: async (...a: [string, number?]) => { historyReads++; return await store.history!(...a); } };
  const r = await CT.runOutreachFollowups({ store: counted, outbox, now: T0 + 8 * DAY, batch: 50 });
  eq([r.people, r.queued, r.errors], [N, N, 0], JSON.stringify(r));
  eq(r.claims, N / 50 + 1, "claims until one comes back empty");
  eq(new Set(queued.map((x) => x.u)).size, N, "everyone, exactly once (was the first 500 only)");
  eq(queued[0].u, `u${String(N - 1).padStart(5, "0")}`, "the oldest due goes first");
  eq(historyReads, 0, "the run reads only the drafts its reminders name, never a whole history");
  const again = await CT.runOutreachFollowups({ store, outbox, now: T0 + 9 * DAY, batch: 50 });
  eq([again.people, again.queued], [0, 0], "fired reminders never queue again");
});

Deno.test("S two runs side by side claim disjoint people; a lease lapses for a run that died; a paused person waits and is released", async () => {
  const store = memoryOutreachStore();
  for (let i = 0; i < 10; i++) await dueFor(store, `p${i}`, T0 + 7 * DAY);
  const now = T0 + 8 * DAY;
  const a = await store.claimDueFollowups!(now, 4, 60_000), b = await store.claimDueFollowups!(now, 4, 60_000);
  eq(a.length + b.length, 8);
  eq(new Set([...a, ...b].map((x) => x.user_id)).size, 8, "no person in both claims");
  // Neither run finished; their leases lapse and the people are claimed again (none lost).
  eq((await store.claimDueFollowups!(now + 1, 100, 60_000)).length, 2, "only the unleased two now");
  eq((await store.claimDueFollowups!(now + 61_000, 100, 60_000)).length, 10, "after the leases lapse, all ten again");
  // A paused person: nothing queued, kept unfired, lease released so a later run checks again.
  const solo = memoryOutreachStore();
  await dueFor(solo, "quiet", T0 + 7 * DAY);
  const box: any[] = [];
  const outbox = { enqueue: async (_u: string, m: any) => { box.push(m); return true; } };
  const paused = await CT.runOutreachFollowups({ store: solo, outbox, now, quiet: async () => new Set(["quiet"]) });
  eq([paused.quiet, box.length], [1, 0]);
  eq((await solo.followups!("quiet"))[0].fired_at, null, "kept for when they resume");
  const resumed = await CT.runOutreachFollowups({ store: solo, outbox, now: now + 1000 });
  eq([resumed.queued, box.length], [1, 1], "released, so the next run sends it once they resume");
});
