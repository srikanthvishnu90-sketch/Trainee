// CONTACT OUTREACH (proposal D-043), the S2 review of #613: one address gets one sequence, ever. approveContactCard
// refused only a full day (`daily_limit`); when the send log said this address already had its first email
// (`already_recorded`), it still saved new drafts and queued the first email and both follow-ups again. After "forget
// everything" the drafts and the rail's queue are empty and the new draft ids are a new idempotency key on the rail, so
// Jane got 6 emails. Now any step that is not newly recorded refuses the approval before anything is saved or queued, and
// the reply says when the person already emailed them. Fails on b2eeabc6, before the fix.
import assertNode from "node:assert/strict";
import { approveContactCard, contactCard, memorySendLimits, sendConfig } from "../../supabase/functions/_shared/career_contact_send.ts";
import { emailHash } from "../../supabase/functions/_shared/career_outreach.ts";
import type { ContactDraft, ContactIn } from "../../supabase/functions/_shared/career_contact_draft.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DAY1 = Date.parse("2026-11-08T15:00:00Z"), DAY2 = Date.parse("2026-11-09T15:00:00Z");
const POSTAL = "Trainee test sender, 100 Main St, Chicago, IL 60601";
const cfg = sendConfig((k: string) => ({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL } as Record<string, string>)[k], true);
const none = async () => new Set<string>();
const contact: ContactIn = {
  person: { name: "Jane Doe", title: "VP Engineering", company: "Acme", domain: "acme.io", source_url: "https://acme.io/team" },
  facts: [],
  email: { email: "jane.doe@acme.io", method: "pattern_rcpt_valid", score: 80, approvable: true, why: "the company's address format (seen 2+ times), accepted by its mail server", provider: "other" },
  expires_at: "2027-02-06T15:00:00.000Z",
};
const draft = (subject: string) => ({ subject, body: "Hi Jane,\n\nI read your rate-limiter repository.\n\nWould you share how you pick defaults?", hook: 1, hook_fact: {}, checks: [] }) as unknown as ContactDraft;
const FUS = ["Hi Jane, following up on my note below in case it got buried.", "Hi Jane, one last note: thanks either way."];

// An empty draft store and an empty rail, as "forget everything" leaves them; each counts what it was given.
function fresh() {
  const seen = { saved: 0, queued: 0 };
  const store = { saveBatch: async (_u: string, _t: unknown, ds: any[]) => { seen.saved += ds.length; return ds.map((d, i) => ({ ...d, id: crypto.randomUUID(), n: i + 1 })); }, update: async () => true } as never;
  const rail = { rpc: async (_f: string, a: any) => { const items = a?.p?.items ?? []; seen.queued += items.length; return { data: items.map(() => ({ status: "queued", id: crypto.randomUUID() })), error: null }; } } as never;
  return { seen, store, rail };
}
const card = async (subject: string) => { const k = await contactCard({ contact, draft: draft(subject), signature: "Sam Lee", followups: FUS, config: cfg, suppressed: none }); if (!k.ok) throw new Error("card"); return k; };

Deno.test("contact resend: the same address approved again (after forget everything) queues nothing and says when it was emailed", async () => {
  const limits = memorySendLimits(); // the send log, which "forget everything" keeps (20261108130500)
  const a = fresh(), k1 = await card("Your rate-limiter repository");
  const first = await approveContactCard({ userId: "u1", card: k1, yesHash: k1.hash, contact, now: DAY1, config: cfg, limits, suppressed: none, store: a.store, rail: a.rail });
  ok(first.ok, JSON.stringify(first));
  eq([a.seen.saved, a.seen.queued], [3, 3], "the first approval: the first email and both follow-ups");

  for (const [label, now] of [["the same day", DAY1], ["the next day", DAY2]] as const) {
    const b = fresh(), k2 = await card(`A new note for Jane (${label})`);
    const again = await approveContactCard({ userId: "u1", card: k2, yesHash: k2.hash, contact, now, config: cfg, limits, suppressed: none, store: b.store, rail: b.rail });
    eq([again.ok, !again.ok && again.why], [false, "already_contacted"], `${label}: refused (${JSON.stringify(again)})`);
    eq([b.seen.saved, b.seen.queued], [0, 0], `${label}: nothing saved, nothing queued`);
    ok(!again.ok && /already emailed Jane Doe on 2026-11-08/.test(again.reply), `${label}: says when, in plain words: ${!again.ok && again.reply}`);
  }

  // Another person may still email Jane: the limits are per person.
  const c = fresh(), k3 = await card("Your rate-limiter repository");
  const other = await approveContactCard({ userId: "u2", card: k3, yesHash: k3.hash, contact, now: DAY1, config: cfg, limits, suppressed: none, store: c.store, rail: c.rail });
  ok(other.ok && c.seen.queued === 3, "another person's first approval goes as before");
});

Deno.test("contact resend: any step already in the log refuses the approval before anything is saved or queued", async () => {
  const limits = memorySendLimits();
  await limits.record({ user: "u3", email_hash: await emailHash("jane.doe@acme.io"), step: 2, day: "2026-11-01", cap: 20 }); // a second follow-up already logged
  const f = fresh(), k = await card("Your rate-limiter repository");
  const r = await approveContactCard({ userId: "u3", card: k, yesHash: k.hash, contact, now: DAY1, config: cfg, limits, suppressed: none, store: f.store, rail: f.rail });
  eq([r.ok, !r.ok && r.why, f.seen.saved, f.seen.queued], [false, "already_contacted", 0, 0], JSON.stringify(r));
});
