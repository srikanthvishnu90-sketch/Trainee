// REQS DOC 2 (progress updates and the "waiting on you" list): "any update?", "how's it going?" and "what's waiting on
// me?" answered by code from the situation the handler reads every turn (career_situation.ts, WO-100), before the router.
// Before this, "any update?" reached the router's tracker for the one thread (often "Your application tracker is empty"
// while the apply queue had applications) and "how's it going?" or "what's waiting on me?" got "I'm not sure which part
// of your search that's about".
//   overview  one current-state answer across everything in flight, in fixed sections: what the employer confirmed
//             (with the confirmation), what was sent and is not confirmed yet (never counted as confirmed), what is running,
//             what is blocked and the exact step that unblocks it, interviews coming up and the tracker's own rows. The
//             headline counts only employer-confirmed applications as done.
//   waiting   a numbered list of what only the person can do: the item, what is needed, how long it has waited.
// A source that could not be read is named and never guessed; an empty account says so. Read only: nothing is changed.
import type { Situation, Task } from "./career_situation.ts";

export const OVERVIEW_INTENT = "career_overview";
export const WAITING_INTENT = "career_waiting_on_you";
export type OverviewAsk = { kind: "overview" } | { kind: "waiting" };

const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()} `;
const OVERVIEW = /^ (?:(?:hey|hi|ok|okay|so)[,]? )?(?:any (?:updates?|news|progress)(?: (?:yet|so far|for me|today))?|(?:give me|send me|got) (?:an? )?(?:update|status update|progress update|status)|update me|status(?: update| report| check)?|(?:what'?s|what is) (?:the|my) (?:status|update|progress|latest)|(?:what'?s|what is) (?:the )?(?:status|latest)(?: on everything| overall)?|how(?:'?s| is) (?:it|everything|my (?:job )?search|the (?:job )?search) going(?: so far)?|how are things(?: going)?|where are we(?: at)?(?: with everything)?|(?:what'?s|what is) going on(?: with my (?:job )?search)?|where do things stand) $/;
const WAITING = /^ (?:so )?(?:(?:what'?s|what is|what are you|is anything|anything) waiting on me(?: for)?|what do i (?:need|have) to do(?: next| now)?|what do i owe you|what(?:'?s| is) on my plate|what am i holding up|(?:what are )?my to-?dos?|what(?:'?s| is) (?:pending|left) (?:on|for) me|what needs me|what do you need me to do) $/;

export function overviewAsk(message: string): OverviewAsk | null {
  const t = plain(message);
  if (WAITING.test(t)) return { kind: "waiting" };
  if (OVERVIEW.test(t)) return { kind: "overview" };
  return null;
}

const DAY = 86_400_000;
const day = (iso: string | null | undefined) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
const age = (iso: string | null | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((now - t) / DAY);
  return d <= 0 ? "since today" : `${d} day${d === 1 ? "" : "s"}`;
};
const name = (t: Task) => `${t.company ?? "An employer"}${t.title ? ` (${t.title})` : ""}`;
const lost = (s: Situation) => (s.unreadable.length ? [`Not read just now, so not included: ${s.unreadable.join(", ")}.`] : []);

export function overviewText(s: Situation, now: number): string {
  const T = s.tasks;
  const apps = T.filter((t) => t.kind === "application");
  const confirmed = apps.filter((t) => t.state === "confirmed");
  const unconfirmed = apps.filter((t) => t.state === "submitted_unconfirmed");
  const unknown = apps.filter((t) => t.state === "unknown_outcome");
  const running = T.filter((t) => ["queued", "driving", "waiting_extension"].includes(t.state) || (t.kind === "outreach" && ["approved", "sending"].includes(t.state)));
  const blocked = T.filter((t) => t.kind !== "question" && t.blocker?.who === "person");
  const questions = T.filter((t) => t.kind === "question");
  const interviews = T.filter((t) => t.kind === "interview");
  const tracked = T.filter((t) => t.kind === "tracked");
  const L: string[] = [];
  L.push(`Status as of now: ${confirmed.length} confirmed by the employer, ${unconfirmed.length + unknown.length} sent but not confirmed, ${running.length} in progress, ${blocked.length + (questions.length ? 1 : 0)} waiting on you.`);
  if (confirmed.length) L.push("Confirmed by the employer:", ...confirmed.map((t) => `- ${name(t)}${t.evidence.confirmation_id ? `, confirmation ${t.evidence.confirmation_id}` : ""}${t.since ? ` (${day(t.since)})` : ""}`));
  if (unconfirmed.length || unknown.length) L.push("Sent, not confirmed by the employer yet:", ...unconfirmed.map((t) => `- ${name(t)}: sent${t.since ? ` ${day(t.since)}` : ""}, no confirmation from them yet`), ...unknown.map((t) => `- ${name(t)}: I can't tell whether it reached them; it will not be sent again`));
  if (running.length) L.push("In progress:", ...running.map((t) => `- ${name(t)}: ${t.state === "driving" ? "being sent now" : t.state === "waiting_extension" ? "asked for, not prepared yet" : t.kind === "outreach" ? "approved, sends on the schedule" : "approved, waiting to run"}${t.blocker && t.blocker.who !== "person" && t.blocker.how !== "nothing for you to do" && t.blocker.how !== "nothing yet" ? ` (${t.blocker.what}; ${t.blocker.how})` : ""}`));
  if (blocked.length || questions.length) {
    L.push("Waiting on you:", ...blocked.map((t) => `- ${name(t)}: ${t.blocker!.what}. To unblock: ${t.blocker!.how}.`));
    if (questions.length) L.push(`- ${questions.length} question${questions.length > 1 ? "s" : ""} on your applications. To unblock: text "what do you need from me".`);
  }
  if (interviews.length) L.push("Interviews coming up:", ...interviews.map((t) => `- ${name(t)}${t.since ? `: ${day(t.since)}` : ": date not on record"}`));
  if (tracked.length) L.push(`On your tracker (what you told me): ${tracked.slice(0, 6).map((t) => `${name(t)}, ${t.evidence.stage ?? "Submitted"}`).join("; ")}${tracked.length > 6 ? `; and ${tracked.length - 6} more` : ""}.`);
  if (!T.length) L.push("Nothing is in flight: no applications, drafts, questions or interviews on your account. Say \"find jobs\" to start a search.");
  L.push(...lost(s));
  return L.join("\n");
}

export function waitingText(s: Situation, now: number): string {
  const mine = s.tasks.filter((t) => t.blocker?.who === "person");
  if (!mine.length) return ["Nothing is waiting on you right now.", ...lost(s)].join("\n");
  const qs = mine.filter((t) => t.kind === "question"), rest = mine.filter((t) => t.kind !== "question")
    .sort((a, b) => (Date.parse(a.since ?? "") || now) - (Date.parse(b.since ?? "") || now));
  const items = rest.map((t) => `${name(t)}: ${t.blocker!.what}. Needed: ${t.blocker!.how}.${age(t.since, now) ? ` Waiting ${age(t.since, now)}.` : ""}`);
  if (qs.length) {
    const oldest = qs.reduce((m: string | null, q) => (q.since && (!m || q.since < m) ? q.since : m), null);
    const firms = [...new Set(qs.map((q) => q.company).filter(Boolean))];
    items.unshift(`${qs.length} question${qs.length > 1 ? "s" : ""} holding up ${firms.join(", ") || "your applications"}. Needed: text "what do you need from me" and answer by number.${age(oldest, now) ? ` Waiting ${age(oldest, now)}.` : ""}`);
  }
  return [`Waiting on you (${items.length}):`, ...items.map((x, i) => `${i + 1}. ${x}`), ...lost(s)].join("\n");
}

export function overviewTurn(o: { message: string; situation: Situation | null; now: number }): { reply: string; status: string; intent: string } | null {
  const ask = overviewAsk(o.message);
  if (!ask) return null;
  const intent = ask.kind === "overview" ? OVERVIEW_INTENT : WAITING_INTENT;
  if (!o.situation) return { reply: "I couldn't read your account just now, so I can't say where things stand; nothing was changed. Ask me again in a minute.", status: "unreadable", intent };
  return { reply: ask.kind === "overview" ? overviewText(o.situation, o.now) : waitingText(o.situation, o.now), status: "shown", intent };
}
