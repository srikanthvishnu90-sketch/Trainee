// FEATURE 17 (2026-10-26): after the person answers the questions a hosted preparation asked (the questions turn,
// career_apply_questions.ts), their queued postings are prepared again at once, through the same door the apply turn
// kicks (career_apply_from_chat.ts kickPrepare, CAREER_PREPARE_AHEAD_URL), and the reply says so instead of "the next
// time you prepare applications on your computer", which is not true for a person with only a phone. Only when every
// open question is answered (a preparation still waiting on one would only stop on it again), and only for postings in
// their own queue (the door takes nothing else). Nothing is approved, queued or sent here.
import { kickPrepare, prepareConfigured } from "./career_apply_from_chat.ts";

const ON_COMPUTER = /(They go on the forms|It goes on the form) the next time you prepare applications on your computer\./;

// deno-lint-ignore no-explicit-any
export async function prepareAfterAnswers(asked: { reply: string; status?: string } | null, o: { admin: any; userId: string; env: { get(k: string): string | undefined }; fetch: typeof fetch }): Promise<"started" | "failed" | "off" | "skipped"> {
  if (!asked || asked.status !== "answered" || !ON_COMPUTER.test(asked.reply)) return "skipped";
  if (!prepareConfigured(o.env)) return "off";
  const open = await o.admin.rpc("career_apply_questions_open_as", { p_user: o.userId, p_limit: 1 });
  if (open.error) return "skipped";
  if ((open.data ?? []).length) {
    // More are waiting: the application is prepared again here once those are answered, not "on your computer".
    asked.reply = asked.reply.replace(ON_COMPUTER, "Once the rest are answered, I'll prepare your application again here.");
    return "skipped";
  }
  // Every posting waiting in their queue (NO LIMITS: read page by page, never cut at a number).
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const w = await o.admin.from("career_apply_wanted").select("posting_key").eq("user_id", o.userId).eq("state", "waiting")
      .order("posting_key", { ascending: true }).range(from, from + 999);
    if (w.error) break;
    const page = (w.data ?? []).map((r: { posting_key: string }) => String(r.posting_key));
    ids.push(...page);
    if (page.length < 1000) break;
  }
  if (!ids.length) return "skipped";
  const k = await kickPrepare({ env: o.env, fetch: o.fetch, userId: o.userId, jobIds: ids });
  if (k === "off") return "off";
  asked.reply = asked.reply.replace(ON_COMPUTER, k === "started"
    ? "I'm preparing your application again now with these answers; the card with every exact answer comes here when it's ready."
    : "Preparing it again hasn't started yet; it waits in your queue.");
  return k;
}

// ------------------------------------------------------------------------------------------------ follow-through
// Where a posting they asked for stands before it is on the queue (career_apply_pending_for), in their words.
export interface PendingRow { posting_key: string; company: string; title: string; url: string; stage: string; detail: string | null; open_questions: number; at: string }
export function pendingLine(p: PendingRow): string {
  const name = `${p.company || "An employer"}${p.title ? ` (${p.title})` : ""}`;
  switch (p.stage) {
    case "on_card": return `${name}: ready on the card I sent you; nothing is sent until you approve it there.`;
    case "ready": return `${name}: prepared; the card with every answer is on its way. Nothing is sent until you approve it.`;
    case "stopped": return `${name}: prepared, but you texted STOP, so I'm not sending its card. Text START and ask "show my applications" to see it. Nothing was sent.`;
    case "preparing": return `${name}: being prepared now; nothing is sent until you approve its card.`;
    case "waiting_day_limit": return `${name}: not started yet: today's preparations are used up, so it starts within a day, by itself. Nothing was sent.`;
    case "starting": return `${name}: waiting its turn to be prepared (within minutes); nothing is sent until you approve its card.`;
    case "waiting_on_you": return `${name}: waiting on your answer to ${p.open_questions === 1 ? "1 question" : `${p.open_questions} questions`}; say "what do you need from me". Nothing was sent.`;
    case "no_resume": return `${name}: not prepared: I don't have your resume file to attach. Send it here as a PDF or Word file. Nothing was sent.`;
    case "refused": return `${name}: not prepared: the employer's form could not be filled ahead of time. Nothing was sent.`;
    case "error": return `${name}: not prepared: preparing it failed on my side. Nothing was sent.`;
    default: return `${name}: in your queue, not prepared yet. Nothing was sent.`;
  }
}
// deno-lint-ignore no-explicit-any
export async function pendingRows(admin: any, userId: string): Promise<PendingRow[] | null> {
  const r = await admin.rpc("career_apply_pending_for", { p_user: userId });
  return r.error ? null : (r.data ?? []) as PendingRow[];
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// A status reply (career_apply_status / career_standing) for an employer with no application on record says no more than
// that; when that employer's posting is in their queue, its stage is said too. A reply about every application gets the
// postings not yet on the queue added below it. Mutates `ans.reply`; nothing else.
// deno-lint-ignore no-explicit-any
export async function withPending(ans: { reply: string; intent?: string | null } | null, message: string, o: { admin: any; userId: string; statusAsk: (m: string) => { company: string | null } | null }): Promise<number> {
  if (!ans || ans.intent !== "career_apply_status") return 0;
  const ask = o.statusAsk(message);
  if (!ask) return 0;
  const rows = await pendingRows(o.admin, o.userId);
  if (!rows) { ans.reply = `${ans.reply}\nI couldn't read the applications still being prepared just now.`; return 0; }
  const mine = ask.company ? rows.filter((p) => norm(p.company) && (norm(p.company) === norm(ask.company!) || norm(p.company).startsWith(norm(ask.company!) + " "))) : rows;
  if (!mine.length) return 0;
  // A reply lists 8 for readability; the rest are counted, never dropped silently.
  const lines = mine.slice(0, 8).map((p) => (ask.company ? pendingLine(p) : `- ${pendingLine(p)}`));
  if (mine.length > 8) lines.push(`…and ${mine.length - 8} more still with me; say "show my applications" for every one.`);
  ans.reply = ask.company && /I have no application to .* on record/.test(ans.reply)
    ? lines.join("\n")
    : `${ans.reply}\n${ask.company ? "" : "Not sent yet, still with me:\n"}${lines.join("\n")}`;
  return mine.length;
}

// "cancel my application to X", "don't apply to X", "stop applying to X", "withdraw my X application", "never mind X".
// Only an explicit cancel of an application to a named employer ("stop sending me alerts" is not one).
const CANCEL = [
  /^(?:please )?(?:cancel|withdraw)(?: (?:my|the))? application (?:to|for|at|with) (.+?)(?: please)?$/i,
  /^(?:please )?(?:cancel|withdraw|stop) (?:applying|my application|the application|sending my application) (?:to|for|at|with) (.+?)(?: please)?$/i,
  /^(?:please )?(?:cancel|withdraw) (?:my|the) (.+?) application(?: please)?$/i,
  /^(?:please )?(?:actually,? )?(?:don'?t|do not) (?:apply(?: me)?|send(?: it| my application)?|submit(?: it| my application)?) (?:to|for|at) (.+?)(?: after all)?(?: please)?$/i,
  /^(?:actually,? )?never ?mind(?: the| my)? (.+?) application$/i,
  // ROUTING SCENARIOS (2026-10-29): "withdraw from X" and "remove X from my list / queue" are this ask. Before, the people
  // search read "withdraw" as a job title at X, and the contacts turn deleted a contact named X ("remove X from my list").
  /^(?:please )?withdraw(?: me| my application)? from (.+?)(?: please)?$/i,
  /^(?:please )?(?:remove|take|drop) (.+?) (?:off|from) my (?:application |apply )?(?:list|queue)(?: please)?$/i,
];
// A greeting or "ok so" before the ask is not part of it ("hey don't apply to X" is the cancel, never an apply).
const LEAD = /^(?:(?:hey|hi|hello|ok|okay|so|pls|please|actually|oh|um|wait|can you|could you|would you)\b[,!:]?\s+)+/i;
// A second ask joined to the employer ("withdraw from X and apply to Y") is not an employer's name: the router asks.
const SECOND_ASK = /(?:\b(?:and|then|also|plus)|[,;])\s+(?:(?:please|pls|just|instead)\s+)?(?:apply|cancel|withdraw|connect|email|message|send|find|show|tell|check|stop|remove|reach|contact|who|what|where|how)\b/i;
export function cancelAsk(message: string): string | null {
  const t = String(message ?? "").replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/[^\p{L}\p{N}"')]+$/u, "")
    .replace(/(?:,? (?:thanks|thank you|thx|ty|pls))+$/i, "").replace(/[.!?]+\s*$/, "").replace(LEAD, "");
  if (t.length > 160) return null;
  for (const re of CANCEL) {
    const m = re.exec(t);
    if (!m) continue;
    const co = m[1].replace(/^(?:the|my) /i, "").replace(/ (?:application|job|role|one)$/i, "").trim();
    if (!co || /^(?:it|that|this|everything|all|applying|application|applications)$/i.test(co) || co.split(" ").length > 6 || SECOND_ASK.test(co)) return null;
    return co;
  }
  return null;
}
export const CANCEL_INTENT = "career_apply_cancel";
// deno-lint-ignore no-explicit-any
export async function cancelTurn(o: { message: string; userId: string; admin: any }): Promise<{ reply: string; status: string; intent: string } | null> {
  const co = cancelAsk(o.message);
  if (!co) return null;
  const r = await o.admin.rpc("career_apply_cancel_for", { p_user: o.userId, p_company: co });
  if (r.error) return { reply: `I couldn't cancel anything for ${co} just now; nothing was changed. Ask me again in a minute.`, status: "unreadable", intent: CANCEL_INTENT };
  const d = r.data ?? {};
  const did = (d.queued_removed ?? 0) + (d.prepared_removed ?? 0) + (d.approved_cancelled ?? 0);
  const sent = Array.isArray(d.already_sent) ? d.already_sent : [];
  // "Nothing was sent" only when it is true of this employer: nothing being sent now and nothing sent before.
  const nothingWent = !d.being_sent && !sent.length;
  const parts: string[] = [];
  if (did) {
    const what = [d.queued_removed ? "removed it from your queue" : "", d.prepared_removed ? "deleted what I had prepared" : "",
      d.cards_closed ? "closed its card, so a tap on it approves nothing" : "", d.approved_cancelled ? "stopped the approved application before it was sent" : ""].filter(Boolean);
    parts.push(`Cancelled ${co}: I ${what.join(", ")}.${nothingWent ? ` Nothing was sent to ${co}.` : ""}`);
  }
  if (d.being_sent) parts.push(`${d.being_sent === 1 ? "One application" : `${d.being_sent} applications`} to ${co} ${d.being_sent === 1 ? "is" : "are"} being sent right now and can't be stopped midway; I'll tell you how it ended.`);
  if (sent.length) parts.push(`${sent.length === 1 ? "An application" : `${sent.length} applications`} to ${co} ${sent.length === 1 ? "was" : "were"} already sent; a sent application can't be taken back.`);
  if (!parts.length) parts.push(`I have nothing for ${co} in your queue, so there is nothing to cancel. Nothing was sent to ${co} through Trainee.`);
  return { reply: parts.join(" "), status: did ? "cancelled" : d.being_sent || sent.length ? "too_late" : "none", intent: CANCEL_INTENT };
}
