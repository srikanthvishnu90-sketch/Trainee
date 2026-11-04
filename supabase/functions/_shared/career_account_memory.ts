// FEATURE 9 (account memory; DIAGNOSIS-2026-10-25 2.6, 2.7, fix F5): what the live router path keeps about the person
// beyond one thread, after the router has answered a turn.
//
// The profile and the tracker themselves move to the account in the host seam (career_host.js, `memory` on the
// account record, migration 20261026090009). This module does the two things the seam cannot, because they need the
// handler's stores:
//   1. Facts the person stated in chat this turn get a fact_confirmed event and an owner provenance
//      (career_router_evidence.ts evidenceStatedFacts), like a confirmed resume entry. The event is held and written
//      with the turn's commit (agent-chat passes `evidence`), never before it.
//   2. A standing need the router did not understand ("never send me staffing agencies", "remember that I only want
//      roles in Chicago") is kept as a standing instruction on the account, in the brain's own store (career_watch_kv
//      'career:standing', _shared/agent/memory.ts, wiped by an erase), under the brain's own rules (addStanding refuses
//      anything that waives the person's yes). It is only ever the router's fallback: a turn the router answered is
//      never taken from it. "What do you know about me" then lists the standing instructions too.
// Nothing here calls a model, sends anything or changes an approval.
import { addStanding, type MemoryStore, type Standing } from "./agent/memory.ts";
import { type EventStore, recordEvent } from "./agent/timeline.ts";
import { evidenceStatedFacts, type StatedEvidence } from "./career_router_evidence.ts";

// ROOT CAUSE 3 (docs/architect/ROOT-CAUSES-2026-10-31.md): the profile (the confirmed resume and its entries) and the
// tracker are the PERSON's, not one thread's, for everyone who talks to Trainee on more than one surface. Telegram,
// WhatsApp and iMessage share one texting thread and the web opens its own threads, so before this a resume confirmed on
// Telegram was unknown on the web. Account scope needs migration 20261026090009 (the `memory` patch key), which precedes
// 20261030060000 (career_host_commit_evidenced), which every confirmation on trunk already needs.
//   CAREER_ACCOUNT_MEMORY=off  never (the owner's kill switch back to per-thread);
//   CAREER_ACCOUNT_MEMORY=on   always;
//   unset (the default)        when the person has a texting contact linked (every Telegram, WhatsApp or iMessage turn
//                              has one: channel_contacts is how the turn found them), or the account already holds their
//                              memory (once on, it stays on: the account is the record). A contact that could not be read
//                              counts as none (per-thread, as before) unless the account already holds the memory.
// A web-only person keeps per-thread scope by default: an approval stamped before their confirmed facts reach the account
// stays current (the authority fence, 20261026090009, moves when confirmed facts on the account change). When they link a
// phone, their next turn folds the thread's profile into the account, and any approval stamped before is asked again.
export function accountMemoryOn(env: { get(key: string): string | undefined }, person: { textingLinked: boolean | null; accountHasMemory: boolean }): boolean {
  const v = (env.get("CAREER_ACCOUNT_MEMORY") ?? "").trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return person.accountHasMemory || person.textingLinked === true;
}

// The router's answers that mean it did not act on the text.
const UNHANDLED = new Set(["career_catchall", "career_fallback", "honest_unavailable"]);
const RECALL = new Set(["conversation_recall"]);
const QUESTION = /\?\s*$|^(?:what|which|who|when|where|why|how|can|could|would|should|do|does|did|is|are)\b/i;

// A standing need in the person's words, or null. Narrow on purpose: an explicit "remember / keep in mind / from now on",
// or a never about staffing or recruiting agencies, or "I only / never want ...".
export function standingAsk(message: string): { text: string; said: string } | null {
  const said = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!said || said.length > 300 || QUESTION.test(said)) return null;
  const lead = /^(?:please\s+)?(?:remember|note|keep in mind|from now on)(?:\s+that)?[:,]?\s+(.{3,})$/i.exec(said);
  const agencies = /\b(?:never|no|don'?t|do not|avoid|not)\b.{0,40}\b(?:staffing|recruiting|recruitment|temp|third[- ]party)\s+(?:agenc(?:y|ies)|firms?|companies)\b/i.test(said);
  const wants = /^i\s+(?:only|never|don'?t ever|do not ever)\s+(?:want|apply|work|consider)\b.{3,}/i.test(said);
  if (!lead && !agencies && !wants) return null;
  const text = (lead ? lead[1] : said).replace(/[.!\s]+$/, "").trim();
  if (!text || text.length > 160) return null;
  return { text: text.charAt(0).toUpperCase() + text.slice(1), said };
}

export interface MemoryTurnOut { reply: string; intent?: string | null; resultStatus?: string | null }
// What this module changes on the router's reply (null: nothing), and the reply as the person reads it.
export interface MemoryPatch { reply: string; intent?: string; resultStatus?: string }
export interface MemoryTurnResult { patch: MemoryPatch | null; out: MemoryTurnOut; stated: StatedEvidence; standing: "kept" | "refused" | "unreadable" | null }

export async function accountMemoryAfterTurn(o: {
  message: string; userId: string; threadId: string; now: number; out: MemoryTurnOut;
  // deno-lint-ignore no-explicit-any
  statedBefore: any[]; ctx: any; events: EventStore | null | undefined; standing: MemoryStore | null | undefined;
  // KNOWN GAPS (2026-10-30): where the stated facts' fact_confirmed events go. agent-chat passes the turn's held store
  // (heldEvents), so they are written by the turn's own commit (career_host_commit_evidenced, 20261030080000) or not at
  // all: a refused save leaves no event naming a fact no saved record holds. Absent: `events`, as before.
  evidence?: EventStore | null;
}): Promise<MemoryTurnResult> {
  const out = o.out;
  let patch: MemoryPatch | null = null;
  const after = Array.isArray(o.ctx?.statedFacts?.facts) ? o.ctx.statedFacts.facts : [];
  const stated = await evidenceStatedFacts({ userId: o.userId, threadId: o.threadId, now: o.now, message: o.message, before: o.statedBefore, after, events: o.evidence ?? o.events });
  if (stated.untraced || stated.refused) console.error(`career memory: stated facts without an event: ${stated.untraced} not in their words, ${stated.refused} not recorded`);
  let standing: MemoryTurnResult["standing"] = null;
  const ask = o.standing && UNHANDLED.has(String(out.intent)) ? standingAsk(o.message) : null;
  if (ask && o.standing) {
    let had: Standing[] | null = null;
    try { had = await o.standing.standing(o.userId); } catch (e) { console.error("career memory: standing unreadable", (e as Error)?.message ?? e); }
    if (!had) {
      standing = "unreadable";
      patch = { intent: "career_standing_unsaved", resultStatus: "failed", reply: "I could not read your saved instructions just now, so I did not keep this one. Say it again in a moment and I will keep it." };
    } else {
      const r = addStanding(had, { text: ask.text, said: ask.said, now: o.now });
      if (!r.ok) {
        standing = "refused";
        patch = { intent: "career_standing_refused", resultStatus: "blocked", reply: `I did not keep that: ${r.error}` };
      } else {
        try {
          if (r.items.length > had.length) {
            await o.standing.saveStanding(o.userId, r.items);
            await recordEvent(o.events, { user_id: o.userId, at: o.now, kind: "instruction_kept", subject: r.item.text, source: "chat", detail: { id: r.item.id, said: r.item.said, via: "router path" } });
          }
          standing = "kept";
          patch = { intent: "career_standing_kept", resultStatus: "completed",
            reply: `Kept on your account for every conversation: "${r.item.text}". I list it whenever you ask what I know about you. Job searches and alerts do not filter on it yet, so check each role against it before you apply.` };
        } catch (e) {
          console.error("career memory: standing not saved", (e as Error)?.message ?? e);
          standing = "unreadable";
          patch = { intent: "career_standing_unsaved", resultStatus: "failed", reply: "I could not save that instruction just now, so it is not kept. Say it again in a moment and I will keep it." };
        }
      }
    }
  } else if (RECALL.has(String(out.intent))) {
    // "What do you know about me": the router lists only the stated facts. The confirmed resume entries, the tracker and
    // the standing instructions are the account's too, so they are said here, each from its own record.
    const lines = recordLines(o.ctx);
    if (o.standing) {
      try {
        const items = await o.standing.standing(o.userId);
        if (items.length) lines.push(`Standing instructions you gave me: ${items.map((x) => `"${x.text}"`).join("; ")}.`);
      } catch (e) {
        lines.push("Your standing instructions could not be read just now.");
        console.error("career memory: standing unreadable", (e as Error)?.message ?? e);
      }
    }
    if (lines.length) {
      const empty = /^Nothing is on your record yet\b/.test(out.reply);
      patch = { reply: empty ? `Here is what I have on record for you.\n${lines.join("\n")}\nCorrect any of it in your own words, or tell me what to run on it first.` : `${out.reply}\n${lines.join("\n")}` };
    }
  }
  return { patch, out: patch ? { ...out, ...patch } : out, stated, standing };
}

// The profile's confirmed entries and drafts, and the tracker's applications, as lines (none when empty).
// deno-lint-ignore no-explicit-any
export function recordLines(ctx: any): string[] {
  const lines: string[] = [];
  const facts = Array.isArray(ctx?.profile?.facts) && !ctx.profile._fromStatedFacts ? ctx.profile.facts : [];
  // deno-lint-ignore no-explicit-any
  const confirmed = facts.filter((f: any) => f && f.status === "confirmed" && f.needs_confirmation !== true);
  // deno-lint-ignore no-explicit-any
  const drafts = facts.filter((f: any) => f && f.needs_confirmation === true);
  // deno-lint-ignore no-explicit-any
  const name = (f: any) => String(f.title || f.text || "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 70);
  if (confirmed.length) {
    const shown = confirmed.filter((f: any) => ["education", "experience", "project"].includes(f.kind)).slice(0, 3).map(name).filter(Boolean);
    lines.push(`From your resume: ${confirmed.length} confirmed ${confirmed.length === 1 ? "entry" : "entries"}${shown.length ? ` (${shown.join("; ")})` : ""}.`);
  }
  if (drafts.length) lines.push(`${drafts.length} resume ${drafts.length === 1 ? "entry is a draft" : "entries are drafts"} waiting for your yes; a draft is never used.`);
  const rows = Array.isArray(ctx?.trackStore?.rows) ? ctx.trackStore.rows : [];
  if (rows.length) {
    // deno-lint-ignore no-explicit-any
    const cos = rows.slice(0, 5).map((r: any) => `${r.company || "company not stated"}${r.stage ? `, ${String(r.stage).toLowerCase()}` : ""}`);
    lines.push(`Your tracker: ${rows.length} ${rows.length === 1 ? "application" : "applications"} (${cos.join("; ")}${rows.length > 5 ? "; and more" : ""}).`);
  }
  return lines;
}

// The stated facts the turn started from: the account's record (both of its lists) and this thread's own copy.
// deno-lint-ignore no-explicit-any
export function statedFactsBefore(account: any, snapshot: any): any[] {
  const a = account?.stated_facts;
  return [...(Array.isArray(a?.facts) ? a.facts : []), ...(Array.isArray(a?.keyed) ? a.keyed : []),
    ...(Array.isArray(snapshot?.stores?.statedFacts?.facts) ? snapshot.stores.statedFacts.facts : [])];
}
