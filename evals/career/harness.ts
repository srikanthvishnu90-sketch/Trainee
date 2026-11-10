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
// Production parity added 2026-11-10 (D-055; harness, not brain improvement):
//   - the search step after the router (handler-career.ts FEATURE 5: askFor, searchJudgeTurn over the live board, the reply
//     parts searchReplyParts), over the item's seeded postings: searchStep below. Before, a router search answered from
//     CareerHost's own empty pool and never saw world.postings.
//   - the apply ledger the handler gives the router before every turn (ctx.applyLedger, from the same situation the brain
//     reads), so the router reads the person's applications as it does in production.
// Not covered (disclosed in every report): agent-chat runs about 17 code-first turns (apply, networking, offer, status,
// standing, follow-ups, receipts...) before the router or the brain. This harness does not; "router" here is CareerHost
// plus the search step, and "staged" is the staged decision over that, both without those stages in front. The search step
// runs with the handler's defaults and without the network: no link re-check, no hosted results page, no apply offer.

export const HARNESS = "parity 2026-11-10: account stores (standing, queue, outreach, alerts, interviews), seeded postings, the router's search step and apply ledger; no code-first turns";
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


// ------------------------------------------------------------------------------------------------ the search step
// D-055 (harness parity, 2026-11-10): production never sends the router's own search reply as it is. In agent-chat
// (handler-career.ts, "FEATURE 5", the branch every router answer takes, staged or rollback), once the router has answered,
// askFor reads the search the turn asked for (the router's parse, a correction of the last search such as "actually remote
// only", a widened one) and searchJudgeTurn lists it from the live board (career_postings); its reply replaces the router's,
// and the ask is kept on the thread (discovery.lastAsk) so the next correction starts from it. Before D-055 this harness
// skipped that step: the router answered from its own empty pool, never saw the item's seeded postings (world.postings),
// and a "remote only" correction could never list the remote role the item seeded (R05, five of five runs).
// What runs here is that step as the handler runs it, over the harness's in-memory board, with the handler's defaults: the
// fit judge off (CAREER_JUDGE is not on in production), no link check (the harness has no network: each role is said to be
// "not re-checked"), no hosted results page and no apply offer (both need the hosted stores; without them the handler keeps
// the list in the reply, as here), and no readiness question (the reply writer is off by default).
export type SearchBoard = { search(words: string[], limit: number): Promise<any[]>; open(): Promise<any[]> };
export async function searchStep(o: { message: string; out: { reply: string; intent?: string; resultStatus?: string }; ctx: any; before: any; board: SearchBoard; userId: string; now: number }): Promise<{ reply: string; searched: boolean }> {
  const J = await import("../../supabase/functions/_shared/career_search_judge.ts");
  const { correctedAsk } = await import("../../supabase/functions/_shared/search_correction.ts");
  const ctx = o.ctx, message = o.message;
  const said = J.askFor(message, o.out, ctx.discovery);
  if (!said) {
    // Spec 2.3, as the handler: a turn that was not a search ends the search a correction could amend.
    if (ctx.discovery?.lastAsk) ctx.discovery = { ...ctx.discovery, lastAsk: null, lastAskAt: null };
    return { reply: o.out.reply, searched: false };
  }
  const live = (p: any) => ({ job_id: String(p.job_id), company: p.company ?? "", title: String(p.title ?? ""), location: p.location ?? "", url: p.url ?? "", description: p.description ?? "",
    first_seen_at: p.first_seen_at ?? null, closed_at: p.closed_at ?? null, pay: p.pay ?? null });
  const sources = {
    async live(words: string[], limit: number) { return (await o.board.search(words, limit)).map(live); },
    async liveHasRows() { return (await o.board.open()).length > 0; },
    // The handler's scoped read (supabaseSearchSources.scoped): every title word, the level, and the place or remote, by location.
    async scoped(s: { titleWords: string[]; intern: boolean; places: string[]; remote: boolean; limit: number; offset: number }) {
      const has = (v: unknown, w: string) => String(v ?? "").toLowerCase().includes(w.toLowerCase());
      return (await o.board.open()).filter((p) => s.titleWords.every((w) => has(p.title, w)) && (!s.intern || has(p.title, "intern"))
        && (!s.places.length && !s.remote || s.places.some((pl) => has(p.location, pl)) || (s.remote && has(p.location, "remote"))))
        .slice(s.offset, s.offset + s.limit).map(live);
    },
    // The snapshot (career_kb_postings) is not part of this harness: the item's world is the live board.
    async snapshot() { return []; },
  };
  const found = await J.searchJudgeTurn({ message, ask: said.ask, userId: o.userId, now: o.now, profile: ctx.profile ?? null, sources: sources as any, judge: { on: false }, want: said.ask.want ?? null });
  if (!found) return { reply: o.out.reply, searched: false };
  const { why, resumeLine } = J.searchReplyParts({ message, said, found, profile: ctx.profile ?? null, prior: o.before });
  const prior = ctx.discovery ?? {};
  ctx.discovery = { ...prior, lastShortlist: found.shortlist, lastSource: found.source, lastAsk: said.ask, lastAskAt: Date.now(),
    ...(correctedAsk(message, prior) ? { lastParams: { ...(prior.lastParams ?? {}), ask: String(message).slice(0, 200), roleText: said.ask.role, whereText: said.ask.place, remote: said.ask.remote } } : {}) };
  return { reply: why + (said.append ? `${o.out.reply}\n\n${found.reply}` : found.reply) + resumeLine, searched: true };
}
