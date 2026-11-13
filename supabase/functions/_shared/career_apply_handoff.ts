// D-072 (item 4, round 2): the hand-off at a wall the rules keep, in chat. The apply VM stopped an approved application at an
// employer's sign-in, a shown verification check or an emailed code, with everything else filled and nothing sent, and recorded
// the hand-off (evidence.handoff: the one step in words and one https link to the employer's page, workers/career-browser/
// handoff.cjs). The person finishes ONLY that step themselves, in their own browser at that link; Trainee never signs in, never
// takes a password or a code through chat, never solves a check. Then, here:
//   "done"      -> career_apply_handoff_done_as: the row is re-queued for a RE-CHECK. Trainee's cloud browser re-opens the posting
//                  in a new session (none of the person's cookies), fills it to the instant before Submit and records the exact
//                  answers the page holds as a card (evidence.answers_card, its hash). Nothing is sent by that run.
//   "done" again, once the re-check has recorded the card -> the card is shown (its hash rides the reply's meta), or, when the
//                  employer kept the step in the person's own browser session (evidence.needs_extension), the reply says the
//                  application is theirs to finish in their browser: never sent by the cloud, never counted as sent.
//   "yes"       -> only when this thread's last reply showed that card: career_apply_handoff_yes_as with the card's hash. The VM
//                  presses Submit only if the page still holds exactly that card. Any other text approves nothing.
// Code decides every step; no model, no canned facts: every name and answer shown comes from the row the VM wrote.
import { readApproval } from "./approval_words.ts";

export const HANDOFF_INTENT = "career_apply_handoff";
export const HANDOFF_CARD_INTENT = "career_apply_handoff_card";
export const HANDOFF_YES_INTENT = "career_apply_handoff_yes";

export interface HandoffRow {
  id: string;
  company: string;
  state: string;
  reason: string | null;
  handoff_done_at: string | null;
  evidence: {
    handoff?: { step?: string; link?: string | null; reason?: string } | null;
    answers_card?: { hash?: string; answers?: { field: string; value: string }[] } | null;
    needs_extension?: boolean;
    link?: string | null;
  };
}
export interface HandoffStore {
  // The person's application rows that hold a hand-off: walls waiting for their step, re-checks queued, cards waiting for a yes.
  rows(userId: string): Promise<HandoffRow[]>;
  done(userId: string, id: string): Promise<{ ok: boolean; why?: string }>;
  yes(userId: string, id: string, cardHash: string): Promise<{ ok: boolean; why?: string }>;
  // The hand-off card this thread's last reply showed ({ id, hash }), or null.
  lastShown(threadId: string): Promise<{ id: string; hash: string } | null>;
}
export interface HandoffTurn { reply: string; intent: string; status: string; meta?: Record<string, unknown> }

// "done", "I'm done", "finished", "did it", "signed in", "verified", "ok done" (a short message, nothing else in it).
const DONE = /^(?:ok(?:ay)?[,. ]+)?(?:i(?:'m| am| have| just)?\s+)?(?:all\s+)?(?:done|finished|did it|completed(?: it)?|signed in|logged in|verified|i'?ve done it|that'?s done|it'?s done)(?:\s+(?:now|with (?:it|that|the step|the check|the sign[- ]?in)))?[.! ]*$/i;
export const isDone = (m: string) => String(m || "").trim().length <= 60 && DONE.test(String(m || "").trim().replace(/’/g, "'"));
const WALLS = new Set(["login_required", "bot_check", "email_code"]);
const waitingStep = (r: HandoffRow) => r.state === "needs_user" && WALLS.has(String(r.reason)) && !!r.evidence?.handoff && !r.evidence?.needs_extension;
const cardReady = (r: HandoffRow) => r.state === "needs_user" && r.reason === "ready_for_yes" && /^[0-9a-f]{64}$/.test(String(r.evidence?.answers_card?.hash || ""));
const rechecking = (r: HandoffRow) => (r.state === "queued" || r.state === "driving") && !!r.handoff_done_at;
const needsExtension = (r: HandoffRow) => r.state === "needs_user" && WALLS.has(String(r.reason)) && !!r.evidence?.needs_extension;
const name = (r: HandoffRow) => r.company || "the employer";
const linkOf = (r: HandoffRow) => r.evidence?.handoff?.link || r.evidence?.link || null;

export function cardText(r: HandoffRow): string {
  const answers = r.evidence?.answers_card?.answers || [];
  const lines = answers.map((a) => `- ${a.field}: ${a.value}`);
  return [`${name(r)}: I re-opened the application in my own browser after your step. These are the exact answers on the page now:`, ...lines,
    `Nothing has been sent. Reply yes to submit exactly this, or no to leave it.`].join("\n");
}

// `hold`: this turn is not the hand-off's to answer (the person's "don't apply" limit holds every card's yes, or another reply
// answers this turn first). Nothing is read and nothing is recorded: no done, no yes.
export async function handoffTurn(o: { message: string; userId: string; threadId: string | null; store: HandoffStore; hold?: boolean }): Promise<HandoffTurn | null> {
  if (o.hold) return null;
  const msg = String(o.message || "").trim();
  const done = isDone(msg);
  const approval = done ? null : readApproval(msg);
  const yes = !!approval && (approval.scope === "batch" || approval.scope === "it");
  if (!done && !yes) return null;
  // A yes is the hand-off's only when this thread's last reply was the hand-off card (D-MS-1: a yes approves exactly what was shown).
  const shown = yes && o.threadId ? await o.store.lastShown(o.threadId) : null;
  if (yes && !shown) return null;
  const rows = await o.store.rows(o.userId);
  if (yes && shown) {
    const r = rows.find((x) => x.id === shown.id);
    if (!r || !cardReady(r) || r.evidence.answers_card!.hash !== shown.hash) {
      return { reply: `${r ? name(r) : "That application"}: the answers on the page changed since I showed them, so nothing was sent. Say done and I'll re-check and show you the new answers.`, intent: HANDOFF_YES_INTENT, status: "refused" };
    }
    const res = await o.store.yes(o.userId, r.id, shown.hash);
    if (!res.ok) return { reply: `${name(r)}: not sent (${res.why ?? "refused"}). Nothing went to the employer.`, intent: HANDOFF_YES_INTENT, status: "refused" };
    return { reply: `${name(r)}: submitting exactly the answers you said yes to. If the page no longer holds exactly them, nothing is sent and I'll tell you. I'll report what the employer's page says.`, intent: HANDOFF_YES_INTENT, status: "queued" };
  }
  // "done": the card first if a re-check recorded one; else a wall waiting for the person's step; else what is still running.
  const ready = rows.filter(cardReady);
  if (ready.length) {
    const r = ready[0];
    return { reply: cardText(r), intent: HANDOFF_CARD_INTENT, status: "awaiting_user", meta: { handoff_card: { id: r.id, hash: r.evidence.answers_card!.hash } } };
  }
  const waiting = rows.filter(waitingStep);
  if (waiting.length) {
    const r = waiting[0];
    const res = await o.store.done(o.userId, r.id);
    if (res.ok) return { reply: `${name(r)}: thanks. I'm re-opening the application in my own browser to check your step is done; nothing will be sent. When it's checked, say done again and I'll show you the exact answers on the page before anything goes.`, intent: HANDOFF_INTENT, status: "rechecking" };
    if (res.why === "needs_extension") {
      const l = linkOf(r);
      return { reply: `${name(r)}: this employer keeps that step in your own browser session, which my browser can't carry, so I can't finish it from here. Finish the application in your browser${l ? ` at ${l}` : ""} (or with the Trainee extension). Nothing was sent by me.`, intent: HANDOFF_INTENT, status: "needs_extension" };
    }
    return { reply: `${name(r)}: I can't re-check this one (${res.why ?? "refused"}). Nothing was sent.`, intent: HANDOFF_INTENT, status: "refused" };
  }
  const ext = rows.filter(needsExtension);
  if (ext.length) {
    const r = ext[0], l = linkOf(r);
    return { reply: `${name(r)}: when I re-opened the page in my own browser the step was still there, so this employer keeps it in your own browser session. Finish the application in your browser${l ? ` at ${l}` : ""} (or with the Trainee extension). Nothing was sent by me.`, intent: HANDOFF_INTENT, status: "needs_extension" };
  }
  if (rows.some(rechecking)) return { reply: `Still re-checking the page in my own browser; nothing has been sent. Say done again in a minute to see the answers.`, intent: HANDOFF_INTENT, status: "rechecking" };
  return null;
}

// The store over Supabase: reads as the service role (the handler has checked the signed-in person), writes through the two
// service-role functions of 20261112160000.
export function supabaseHandoffStore(admin: { from(t: string): any; rpc(n: string, a: Record<string, unknown>): any }): HandoffStore {
  const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message}`); return r?.data; };
  return {
    async rows(userId) {
      const data = must(await admin.from("career_apply_jobs").select("id,company,state,reason,handoff_done_at,evidence")
        .eq("user_id", userId).in("state", ["needs_user", "queued", "driving"]).order("updated_at", { ascending: false }).limit(50), "read hand-offs");
      return ((data ?? []) as HandoffRow[]).filter((r) => r.evidence?.handoff || r.handoff_done_at || r.reason === "ready_for_yes");
    },
    async done(userId, id) { return must(await admin.rpc("career_apply_handoff_done_as", { p_user: userId, p_id: id }), "hand-off done") ?? { ok: false }; },
    async yes(userId, id, cardHash) { return must(await admin.rpc("career_apply_handoff_yes_as", { p_user: userId, p_id: id, p_card_hash: cardHash }), "hand-off yes") ?? { ok: false }; },
    async lastShown(threadId) {
      const rows = must(await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply");
      const m = rows?.[0]?.meta?.handoff_card;
      return m && typeof m.id === "string" && typeof m.hash === "string" ? { id: m.id, hash: m.hash } : null;
    },
  };
}
