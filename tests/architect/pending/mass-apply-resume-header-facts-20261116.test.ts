// MASS APPLY CONVERSATIONS (2026-11-16, architect design for eval MA05): the confirmed resume's contact line answers the forms.
// At the person's yes to their resume (the router's confirm of a pasted resume), each header value that was shown to them and
// is in their own upload becomes a confirmed fact with its own persisted fact_confirmed event and the owner provenance of the
// resume's entries; the trust contract (prepare-ahead.ts trustedProfile, apply_core.ts trustedManifest) then keeps it, so
// name, email and phone are no longer asked on every application. No event is invented: an unconfirmed header, a value never
// shown, or an event that cannot be recorded adds nothing; a first and a last name only from a name of exactly two words.
import assertNode from "node:assert/strict";
import { evidenceResumeConfirmation, heldEvents } from "../../../supabase/functions/_shared/career_router_evidence.ts";
import { trustedProfile } from "../../../workers/career-browser/prepare-ahead.ts";
import { trustedManifest } from "../../../extension/src/apply_core.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
const RESUME = "Maya Fictional\nChicago, IL | maya.fictional@example.test | +1 555-0142\n\nEDUCATION\nExample College - B.S. Statistics";
const header = { name: "Maya Fictional", email: "maya.fictional@example.test", location: "Chicago, IL", contactLine: "Chicago, IL | maya.fictional@example.test | +1 555-0142", confirmed_at: "2026-11-16T15:00:00.000Z" };
const shownText = `At the top: Maya Fictional | ${header.contactLine}\n1. Example College - B.S. Statistics`;
async function confirm(o: { header?: any; shown?: string; events?: any } = {}) {
  const after = { user_id: U, facts: [] as any[], resume_header: o.header === undefined ? header : o.header };
  const r = await evidenceResumeConfirmation({ userId: U, now: Date.parse("2026-11-16T15:00:00Z"), message: "yes, that's my resume", before: { facts: [] }, after,
    out: { intent: "career_resume_ingest", resultStatus: "completed" }, shown: { text: o.shown ?? shownText, message_ids: ["1"] },
    upload: { kind: "message", ref: "m1", sha256: "a".repeat(64), text: RESUME }, events: o.events ?? heldEvents() });
  const prof = trustedProfile({ ...after, user_id: U }, U, []);
  const answers = trustedManifest({ owner: U, file: { user_id: U, answers: {}, saved: {}, facts: prof?.facts ?? [] }, rows: [], resume: null }).answers;
  return { r, answers: Object.fromEntries(Object.entries(answers).map(([k, v]: [string, any]) => [k, v.value])) };
}

Deno.test("a confirmed header: name, email and phone are kept by the trust contract, each with its own recorded event", async () => {
  const events = heldEvents();
  const { r, answers } = await confirm({ events });
  eq(r.header, 5);
  eq(answers, { full_name: "Maya Fictional", first_name: "Maya", last_name: "Fictional", email: "maya.fictional@example.test", phone: "+1 555-0142" });
  eq(events.rows().filter((e) => e.kind === "fact_confirmed").length, 5);
});
Deno.test("an unconfirmed header, words never shown, or an event that is not recorded: nothing is used", async () => {
  eq((await confirm({ header: { ...header, confirmed_at: null } })).answers, {});
  eq((await confirm({ shown: "1. Example College - B.S. Statistics" })).answers, {}, "the header was not shown at the yes");
  const refusing = { add: async () => { throw new Error("down"); }, addMany: async () => { throw new Error("down"); }, recall: async () => [] };
  eq((await confirm({ events: refusing })).answers, {}, "no event, no fact");
});
Deno.test("a name that is not exactly two words is kept whole, never split on a guess", async () => {
  const h = { ...header, name: "Maya de la Cruz" };
  const { answers } = await confirm({ header: h, shown: shownText.replace("Maya Fictional", "Maya de la Cruz") });
  eq([answers.first_name, answers.last_name], [undefined, undefined]);
});
