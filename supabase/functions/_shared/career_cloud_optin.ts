import { parsePace } from "./career_apply.ts";
import { resumeRecordTurn, type ResumeRecordStore, supabaseResumeRecordStore } from "./career_resume_record.ts";
// WO-039: the person turns the cloud on and off in chat. Code's, like the card: the model never decides it.
//
// "apply for me in the cloud" shows the terms in exact words: which postings (only what they approve on a card, on
// Greenhouse, Lever and Ashby, on a site whose hand submissions employers have confirmed), how many a day (their own
// daily limit, one per company every 30 days), that each one still needs their yes on its card, and that a
// verification check comes back to them. Only an explicit "yes" (or "yes, turn it on") turns it on, and only when all of
// these hold: the terms are the thread's last word, they were shown in the last 30 minutes, nothing was texted to the
// person since (receipts, alerts and status texts go out through the outbox without being written to the thread, so
// "the last word" alone could be days old), and their hash is the hash of the terms as they would be shown now. One text
// turns it off ("cloud off"), at any time.
//
// Off is never "stop": over SMS, STOP is the carrier's opt-out keyword (trainee-inbound silences every text on it).

export const CLOUD_INTENT = "career_cloud_optin";

export type CloudCommand = { kind: "ask" } | { kind: "off" } | { kind: "status" };
export function parseCloudCommand(text: string): CloudCommand | null {
  const t = String(text ?? "").toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (/^(turn off|switch off|disable|pause|end|stop using) (the )?cloud( apply(ing)?| applications| sending)?$|^cloud off$|^no (more )?cloud$|^(don'?t|do not) (apply|send) (for me )?(in|from) the cloud( anymore| any more)?$/.test(t)) {
    return { kind: "off" };
  }
  if (/^(is (the )?cloud on|cloud status|is the cloud applying( for me)?)$/.test(t)) return { kind: "status" };
  if (
    /^(please )?(apply|send (my )?applications|submit (my )?applications) (for me )?(in|from|through|via) the cloud( for me)?( please)?$/.test(t) ||
    /^(turn on|switch on|enable) (the )?cloud( apply(ing)?| applications| sending)?$|^cloud on$/.test(t)
  ) return { kind: "ask" };
  return null;
}
// Only an explicit yes: "ok", "sure" or "y" are too easily a reply to something else.
const YES = /^yes(,? turn it on)?$/;
export const TERMS_TTL_MS = 30 * 60_000;
const TERMS_HEAD = "Here is exactly what turning on the cloud means:";
async function sha256(t: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((n) => n.toString(16).padStart(2, "0")).join("");
}
const NOT_ON = 'Nothing was turned on. To turn on the cloud, text "apply for me in the cloud" to see the terms again, then reply "yes".';

// The person's own pace as a number, or null: anything unset, zero, negative, non-finite or not a number is no pace at all
// (the same rule as career_apply.ts dailyLimit and the SQL career_apply_daily_limit after 20261025140000).
export const ownPace = parsePace;
// How many a day, in the person's terms: their own number when they set one, and no product number otherwise.
export function paceText(daily: unknown): string {
  const n = ownPace(daily);
  return n === null ? "with no daily limit unless you set your own pace" : `up to ${n} a day, the pace you set yourself`;
}

export function termsText(daily: number | null): string {
  return [
    TERMS_HEAD,
    "1. Which postings: only applications you approve on a card, on Greenhouse, Lever and Ashby, and only on a site where applications sent by hand have already been confirmed by the employers' own emails.",
    `2. How many a day: ${ownPace(daily) === null ? "no daily limit unless you set your own pace" : paceText(daily)}, and never two to the same company within 30 days.`,
    "3. Each one still needs your yes on its card, one at a time or as a batch. Nothing you have not approved is ever sent.",
    "4. If a site shows a verification check, Trainee does not solve it. It stops and sends you the link to finish that one yourself.",
    'Reply "yes" to turn it on. Text "cloud off" any time to turn it off.',
  ].join("\n");
}

export class PaceUnreadable extends Error { constructor(public raw: string) { super(`saved daily pace unreadable: ${raw}`); } }
const PACE_FIX = (raw: string) => `Your saved daily pace could not be read (it says ${JSON.stringify(raw)}), so I can't show you the cloud's terms yet. Say "set my daily pace to N" (a whole number) or "no daily pace", then ask again.`;
export interface CloudOptinStore {
  dailyLimit(userId: string): Promise<number | null>;
  get(userId: string): Promise<{ enabled: boolean; daily?: number | null }>;
  set(userId: string, on: boolean, terms: string | null): Promise<{ enabled: boolean; daily?: number | null }>;
  lastAssistant(threadId: string): Promise<{ intent: string | null; content: string | null; at: number | null }>;
  // How many texts were queued to the person after a time, other than the thread's own replies.
  outboxSince(userId: string, at: number): Promise<number>;
  // ONE CONFIRMED RESUME (20261026120018): "which resume do you have" / "delete my resume" ride this turn, which every
  // channel's text reaches before any brain. Absent: not answered here.
  resume?: ResumeRecordStore;
}

// One turn, before any brain. Null when the text is not about the cloud, so the turn goes on as before.
export async function cloudTurn(
  o: { message: string; userId: string; threadId: string; now: number; store: CloudOptinStore },
): Promise<{ reply: string; status: string; intent: string } | null> {
  if (o.store.resume) {
    const r = await resumeRecordTurn({ message: o.message, userId: o.userId, store: o.store.resume });
    if (r) return r;
  }
  const cmd = parseCloudCommand(o.message);
  if (cmd?.kind === "off") {
    await o.store.set(o.userId, false, null);
    return {
      reply: "The cloud is off. Nothing more will be sent from it. Your approved applications wait for your own computer.",
      status: "off",
      intent: "career_cloud_off",
    };
  }
  if (cmd?.kind === "status") {
    const s = await o.store.get(o.userId);
    return {
      reply: s.enabled
        ? `The cloud is on, ${paceText(s.daily)}, and only for applications you approve on a card. Text "cloud off" to turn it off.`
        : `The cloud is off. Text "apply for me in the cloud" to see exactly what turning it on means.`,
      status: s.enabled ? "on" : "off",
      intent: "career_cloud_status",
    };
  }
  if (cmd?.kind === "ask") {
    try { return { reply: termsText(await o.store.dailyLimit(o.userId)), status: "shown", intent: CLOUD_INTENT }; }
    catch (e) { if (e instanceof PaceUnreadable) return { reply: PACE_FIX(e.raw), status: "pace_unreadable", intent: "career_cloud_refused" }; throw e; }
  }
  const t = String(o.message ?? "").toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!YES.test(t)) return null;
  // A yes counts only when the terms were this thread's last word, shown in the last 30 minutes, with nothing texted to the
  // person since, and when the terms shown hash to the terms as they would be shown now.
  const last = await o.store.lastAssistant(o.threadId);
  if (last.intent !== CLOUD_INTENT) return null;
  if (last.at === null || !(o.now - last.at <= TERMS_TTL_MS)) return { reply: NOT_ON, status: "expired", intent: "career_cloud_refused" };
  if ((await o.store.outboxSince(o.userId, last.at)) !== 0) return { reply: NOT_ON, status: "interleaved", intent: "career_cloud_refused" };
  let terms: string;
  try { terms = termsText(await o.store.dailyLimit(o.userId)); }
  catch (e) { if (e instanceof PaceUnreadable) return { reply: PACE_FIX(e.raw) + " " + NOT_ON, status: "pace_unreadable", intent: "career_cloud_refused" }; throw e; }
  const i = (last.content ?? "").indexOf(TERMS_HEAD);
  const shown = i < 0 ? "" : (last.content ?? "").slice(i, i + terms.length);
  if ((await sha256(shown)) !== (await sha256(terms))) {
    return { reply: "Your settings changed since I showed you the terms, so the cloud is still off. " + NOT_ON, status: "changed", intent: "career_cloud_refused" };
  }
  const r = await o.store.set(o.userId, true, terms);
  return {
    reply: `The cloud is on, ${paceText(r.daily)}. Each application still waits for your yes on its card. Text "cloud off" any time to turn it off.`,
    status: "on",
    intent: "career_cloud_on",
  };
}

// The store over the edge function's service client: every call names the person.
export function supabaseCloudOptinStore(admin: any): CloudOptinStore {
  const must = (r: any, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  return {
    resume: supabaseResumeRecordStore(admin),
    async dailyLimit(userId) {
      // The person's own pace, or null for none (CAPS-1390). SERIAL-1430: a saved pace that cannot be read is neither;
      // the ask and the yes stop on it (PaceUnreadable) rather than show terms that say "no daily limit".
      const r = must(await admin.rpc("career_apply_pace_state", { p_user: userId }), "read the daily pace");
      const row = Array.isArray(r) ? r[0] : r;
      if (row?.state === "unreadable") throw new PaceUnreadable(String(row.raw ?? ""));
      return row?.state === "set" ? Number(row.pace) : null;
    },
    async get(userId) {
      const r = must(await admin.rpc("career_apply_cloud_optin_get", { p_user: userId }), "read the cloud setting") ?? { enabled: false };
      return { ...r, enabled: r.enabled === true, daily: ownPace(r.daily) };
    },
    async set(userId, on, terms) {
      const r = must(await admin.rpc("career_apply_cloud_optin_as", { p_user: userId, p_on: on, p_terms: terms }), "set the cloud") ?? { enabled: on };
      return { ...r, enabled: r.enabled === true, daily: ownPace(r.daily) };
    },
    async lastAssistant(threadId) {
      const rows = must(
        await admin.from("agent_messages").select("content,meta,created_at").eq("thread_id", threadId).eq("role", "assistant")
          .order("id", { ascending: false }).limit(1),
        "read the last reply",
      );
      const at = Date.parse(rows?.[0]?.created_at ?? "");
      return {
        intent: rows?.[0]?.meta?.intent ?? null,
        content: typeof rows?.[0]?.content === "string" ? rows[0].content : null,
        at: Number.isFinite(at) ? at : null,
      };
    },
    // Anything that cannot be read counts as something sent: the yes is then refused, never taken.
    async outboxSince(userId, at) {
      try {
        const r = await admin.from("career_outbox").select("id", { count: "exact", head: true }).eq("user_id", userId)
          .neq("kind", "reply").gt("created_at", new Date(at).toISOString());
        return r.error || typeof r.count !== "number" ? Infinity : r.count;
      } catch {
        return Infinity;
      }
    },
  };
}
