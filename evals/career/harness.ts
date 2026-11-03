// The eval harness's outcome (2026-10-26): what a conversation wrote, counted by code, and the expectation an item states
// about it. The brains themselves are makeBrain in run.ts (the router (CareerHost), the full agent brain, and the staged
// release (FEATURE 13)), which a test can drive with a scripted model. Each item runs in a fresh thread through the
// same conversation interface the product uses (handleInbound), with the stores agent-chat gives the brain in production
// (handler-career.ts: alerts, interviews, standing instructions, the apply queue, outreach drafts, postings), kept in
// memory for one synthetic person.
//
// Production parity added 2026-10-26 (harness, not brain improvement; every score from it on carries HARNESS below):
//   - memory: the standing-instructions store (agent-chat passes supabaseMemoryStore; the harness passed none, so every
//     remember_instruction call failed with "standing instructions are not kept here").
//   - wants: the apply queue (agent-chat passes supabaseWantStore; without it queue_applications always failed).
//   - outreach: the drafts store, drafted by the same metered model (agent-chat passes outreachStore + callModel).
//   - postings: an item may seed postings (item.world.postings); search_jobs and get_posting read them, as agent-chat's
//     read the live board. Without a world the board is empty, as before.
//   - the end state the judges see, and the code-checked outcome (outcomeOf), include the account stores, not only the
//     thread snapshot: an alert, an interview, a standing instruction or a queued application is a row the item can expect.
//
// Not covered (disclosed in every report): agent-chat runs about 17 code-first turns (apply, networking, offer, status,
// standing, follow-ups, receipts...) before the router or the brain. This harness does not; "router" here is CareerHost
// alone, and "staged" is the staged decision over CareerHost, both without those stages in front.

export const HARNESS = "parity 2026-10-26: account stores (standing, queue, outreach, alerts, interviews) and seeded postings; no code-first turns";
export type BrainName = "router" | "agent" | "staged";
export type ModelFn = (payload: any) => Promise<any>;
export type Outcome = {
  facts: number; facts_confirmed: number; standing: number; alerts: number; tracked: number; interviews: number;
  queued: number; outreach_drafts: number; sent: number;
};
export const OUTCOME_KEYS: (keyof Outcome)[] = ["facts", "facts_confirmed", "standing", "alerts", "tracked", "interviews", "queued", "outreach_drafts", "sent"];

// One expectation per outcome key: an exact count, or a range. `sent` must always be 0 in this harness (nothing here can
// send), and an item that does not name it still has it checked.
export type Expect = Partial<Record<keyof Outcome, number | { min?: number; max?: number }>>;
export function checkExpect(expect: Expect | undefined, o: Outcome): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  const all: Expect = { sent: 0, ...(expect ?? {}) };
  for (const [k, want] of Object.entries(all) as [keyof Outcome, Expect[keyof Outcome]][]) {
    if (!OUTCOME_KEYS.includes(k)) { failed.push(`${k}: not an outcome key`); continue; }
    const got = o[k];
    if (typeof want === "number") { if (got !== want) failed.push(`${k}: expected ${want}, got ${got}`); continue; }
    if (want && want.min !== undefined && got < want.min) failed.push(`${k}: expected at least ${want.min}, got ${got}`);
    if (want && want.max !== undefined && got > want.max) failed.push(`${k}: expected at most ${want.max}, got ${got}`);
  }
  return { ok: failed.length === 0, failed };
}

const arr = (x: unknown): any[] => Array.isArray(x) ? x : [];
// A watch the router set by text: module 152's profile record (career:watch-profile:<user>), live by the host's own rule
// (career_host.js watchProfileActive: at least one interest and no global opt-out).
export function routerWatches(box: any): number {
  if (!box || typeof box !== "object") return 0;
  return Object.entries(box).filter(([k, wp]: [string, any]) => /^career:watch-profile:/.test(k) &&
    !!(wp && Array.isArray(wp.interests) && wp.interests.length && !(wp.opt_out && wp.opt_out.global))).length;
}
// The outcome of one conversation, counted by code from the end state (never by a judge).
export function outcomeOf(state: any): Outcome {
  const s = state?.stores ?? {}, a = state?.account ?? {};
  const facts = arr(s.profile?.facts);
  const rows = arr(s.trackStore?.rows);
  const alertOn = a.alerts?.prefs?.on === true ? 1 : 0;
  const drafts = arr(a.outreach?.drafts);
  return {
    facts: facts.length,
    facts_confirmed: facts.filter((f) => f && f.needs_confirmation === false || f?.status === "confirmed").length,
    standing: arr(a.standing).length,
    alerts: Math.max(alertOn, routerWatches(s.alertWatchState) ? 1 : 0),
    tracked: rows.length,
    interviews: arr(a.interviews).length,
    queued: arr(a.queue).length,
    outreach_drafts: drafts.length,
    sent: drafts.filter((d) => /^(sent|sending|delivered)$/.test(String(d?.status ?? ""))).length,
  };
}

