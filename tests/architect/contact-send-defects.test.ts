// CONTACT OUTREACH (proposal D-043), reproduced defects in PR #594's send. Each test fails on the code before its fix:
//   4. test mode fails closed: CAREER_CONTACT_TEST_RECIPIENTS with a display name ("Owner <owner@trainee.dev>") or with
//      ";" or whitespace between addresses is parsed; set but with nothing that parses, every card is refused (before the
//      fix the list came back empty and the card went to the real person's address);
//   5. one yes covers exactly one card: the card's hash binds every mail on it (the first email and each follow-up, in
//      order, with when each goes), so a yes to one card never approves another that shares only its first email.
import assertNode from "node:assert/strict";
import { approveContactCard, contactCard, memorySendLimits, sendConfig, testRecipients } from "../../supabase/functions/_shared/career_contact_send.ts";
import type { ContactDraft, ContactIn } from "../../supabase/functions/_shared/career_contact_draft.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const POSTAL = "Trainee test sender, 100 Main St, Chicago, IL 60601";
const env = (m: Record<string, string>) => (k: string) => m[k];
const none = async () => new Set<string>();
const REAL = "jane.doe@acme.io";
const contact: ContactIn = {
  person: { name: "Jane Doe", title: "VP Engineering", company: "Acme", domain: "acme.io", source_url: "https://acme.io/team" },
  facts: [],
  email: { email: REAL, method: "pattern_rcpt_valid", score: 80, approvable: true, why: "the company's address format (seen 2+ times), accepted by its mail server", provider: "other" },
  expires_at: "2027-02-05T15:00:00.000Z",
};
const draft = { subject: "Your rate-limiter repository", body: "Hi Jane,\n\nI read your rate-limiter repository.\n\nWould you share how you pick defaults?", hook: 1, hook_fact: {} as never, checks: [] } as ContactDraft;
const card = (config: ReturnType<typeof sendConfig>, followups?: string[]) => contactCard({ contact, draft, signature: "Sam Lee", followups, config, suppressed: none });

Deno.test("contact defect 4: test recipients with display names and any separator are parsed; set but unparseable refuses every card", async () => {
  eq(testRecipients("Owner <owner@trainee.dev>"), ["owner@trainee.dev"], "a display name");
  eq(testRecipients("owner@trainee.dev; second@trainee.dev"), ["owner@trainee.dev", "second@trainee.dev"], "a semicolon");
  eq(testRecipients("owner@trainee.dev second@trainee.dev\tthird@trainee.dev\nfourth@trainee.dev"), ["owner@trainee.dev", "second@trainee.dev", "third@trainee.dev", "fourth@trainee.dev"], "whitespace");
  eq(testRecipients('"Owner, Trainee" <Owner@Trainee.dev>, Second Person <second@trainee.dev>;third@trainee.dev'), ["owner@trainee.dev", "second@trainee.dev", "third@trainee.dev"], "quoted names with commas, mixed separators, case");
  eq(testRecipients('"jane.doe@acme.io" <owner@trainee.dev>'), ["owner@trainee.dev"], "an address in a display name is never a recipient");
  eq(testRecipients("owner@trainee.dev, owner@trainee.dev"), ["owner@trainee.dev"], "duplicates once");

  for (const v of ["Owner <owner@trainee.dev>", "owner@trainee.dev;second@trainee.dev"]) {
    const k = await card(sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL, CAREER_CONTACT_TEST_RECIPIENTS: v }), true));
    ok(k.ok && k.to === "owner@trainee.dev" && k.found === REAL && k.test_mode, `${v}: addressed to the owner, never ${REAL}: ${JSON.stringify(k)}`);
  }
  for (const v of ["Owner", "owner(at)trainee.dev", "<>", ";", "  ,  "]) {
    const cfg = sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL, CAREER_CONTACT_TEST_RECIPIENTS: v }), true);
    eq(cfg.testMode, true, `${JSON.stringify(v)}: set, so test mode is on`);
    const k = await card(cfg);
    ok(!k.ok && k.why === "test_mode_misconfigured", `${JSON.stringify(v)}: set but nothing parses, so no card at all: ${JSON.stringify(k)}`);
  }
  eq((await card(sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL, CAREER_CONTACT_TEST_RECIPIENTS: "" }), true))).ok && true, true, "unset (empty): not test mode");

  // A card built while test mode parsed, approved after the setting broke: refused, nothing queued.
  const good = await card(sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL, CAREER_CONTACT_TEST_RECIPIENTS: "owner@trainee.dev" }), true));
  if (!good.ok) throw new Error("card");
  const broken = sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL, CAREER_CONTACT_TEST_RECIPIENTS: "Owner" }), true);
  let queued = 0;
  const r = await approveContactCard({ userId: "u1", card: good, yesHash: good.hash, contact, now: Date.parse("2026-11-08T15:00:00Z"), config: broken,
    store: { saveBatch: async () => { queued++; return []; }, update: async () => true } as never, rail: {} as never, limits: memorySendLimits(), suppressed: none });
  eq([r.ok, !r.ok && r.why, queued], [false, "refused", 0], "approval refuses too, before anything is stored");
});

Deno.test("contact defect 5: the card's hash covers every mail on it, in order; a yes to one card never approves another", async () => {
  const cfg = sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL }), true);
  const a = await card(cfg, ["Hi Jane, following up on my note below.", "Hi Jane, one last note: thanks either way."]);
  const b = await card(cfg, ["Hi Jane, following up: I can send the gateway code.", "Hi Jane, one last note: thanks either way."]);
  const solo = await card(cfg);
  const swapped = await card(cfg, ["Hi Jane, one last note: thanks either way.", "Hi Jane, following up on my note below."]);
  if (!a.ok || !b.ok || !solo.ok || !swapped.ok) throw new Error("cards");
  eq(a.mails[0].hash, b.mails[0].hash, "the same first email");
  ok(a.hash !== b.hash, "different follow-ups: a different card hash");
  ok(a.hash !== solo.hash && b.hash !== solo.hash, "a card with follow-ups is not the card without them");
  ok(a.hash !== swapped.hash, "the order of the follow-ups is part of it");
  eq(a.hash, (await card(cfg, ["Hi Jane, following up on my note below.", "Hi Jane, one last note: thanks either way."])).ok && (await card(cfg, ["Hi Jane, following up on my note below.", "Hi Jane, one last note: thanks either way."]) as { hash: string }).hash, "the same card: the same hash");
  const later = await card({ ...cfg, followupDays: 7 }, ["Hi Jane, following up on my note below.", "Hi Jane, one last note: thanks either way."]);
  ok(later.ok && later.hash !== a.hash, "when the follow-ups go is part of it");

  let stored = 0;
  const deps = { userId: "u1", contact, now: Date.parse("2026-11-08T15:00:00Z"), config: cfg, limits: memorySendLimits(), suppressed: none, rail: {} as never,
    store: { saveBatch: async () => { stored++; return []; }, update: async () => true } as never };
  const cross = await approveContactCard({ ...deps, card: b, yesHash: a.hash });
  eq([cross.ok, !cross.ok && cross.why, stored], [false, "changed", 0], "a's yes never approves b");
  const forged = await approveContactCard({ ...deps, card: { ...b, hash: a.hash }, yesHash: a.hash });
  eq([forged.ok, !forged.ok && forged.why, stored], [false, "changed", 0], "a card whose hash does not match its own mails is refused");
  const firstOnly = await approveContactCard({ ...deps, card: b, yesHash: b.mails[0].hash });
  eq([firstOnly.ok, !firstOnly.ok && firstOnly.why, stored], [false, "changed", 0], "the first email's own hash does not approve the follow-ups");
});
