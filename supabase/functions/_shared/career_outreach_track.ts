// FAMILY NETWORKING (2026-10-26): what happens to networking mail after it is drafted, on the live chat path (called by
// career_networking.ts networkingTurn, which handler-career.ts already runs code-first). Sending from the person's own
// address is not available (gmail.send is deferred), so a person sends their approved email themselves; this turn keeps
// the record true and the follow-through going:
//   sent       "sent 1", "I sent it", "I emailed Maya": the person's own draft marked sent by them (career_outreach_drafts
//              status 'sent', result 'sent_by_you'), so Trainee can never send it a second time, and a follow-up reminder
//              set for FOLLOWUP_DAYS later.
//   replied    "Maya replied", "heard back from Maya": status 'replied'; the reminder is off.
//   remind     "remind me to follow up with Maya in 3 days": the reminder moved to that day; "no reminder" drops it.
//   list       "who have I reached out to": every person on record and where each stands, with the reminder's day.
//   follow     "follow up with Maya": a short follow-up drafted from confirmed facts (draftFor's fact-lock) as a new
//              outreach batch, approved like any other by its exact text.
//   site       "message Maya on LinkedIn for me", "apply to the X job on Indeed", "message recruiters on Handshake", or a
//              linkedin.com / indeed.com (any country) / joinhandshake.com link: refused plainly, naming the site (Trainee
//              never signs in to or automates LinkedIn, Indeed or Handshake), with what it can do instead. Nothing is
//              recorded and nothing is left waiting, so a later "yes" answers whatever it was meant for. The chat runs this
//              (siteAsk) before every apply, link-read and batch turn (career_networking.ts siteRefusedTurn).
// The reminder fires from runOutreachFollowups (the scheduled run): once, to the person's outbox, only while no reply is
// on record. Every record is the person's own (by user id); a name matches only someone they wrote to through Trainee.
import type { Outbox } from "./career_alert_store.ts";
import { neverOpen } from "./career_people_sites.ts";
import type { EventStore } from "./agent/timeline.ts";
import { batchMessages, blockedAddresses, confirmed, draftFor, emailHash, type Followup, FOLLOWUP_DAYS, footerOf, messageOf, type ModelFn, OUTREACH_INTENT,
  type OutreachDraft, type OutreachStore, payloadHash, recordOutreach } from "./career_outreach.ts";

export const TRACK_INTENT = "career_outreach_track";
export const LINKEDIN_INTENT = "career_linkedin_refused";
export const SITE_INTENT = "career_site_refused"; // Indeed and Handshake; LinkedIn keeps LINKEDIN_INTENT
const DAY = 86_400_000;
const TZ = "America/New_York"; // the day the outreach caps use when the person's own zone is not known (dayStartOf)

export type TrackAsk =
  | { kind: "sent"; ns: number[] | null; name: string | null; daysAgo: number }
  | { kind: "replied"; name: string | null }
  | { kind: "remind"; name: string | null; days: number | null }
  | { kind: "no_remind"; name: string | null }
  | { kind: "list" }
  | { kind: "follow"; name: string }
  | { kind: "site"; site: Site };
export type Site = "LinkedIn" | "Indeed" | "Handshake";

const NAME = "([a-z][a-z.'-]*(?: [a-z][a-z.'-]*){0,2}?)";
const NOT_NAME = /^(?:it|them|that|this|those|these|everyone|everybody|anyone|someone|him|her|they|the email|the emails|the draft|my resume|my cv|a|an|the|my|me|you|stripe|google)$/;
const NUMS = "#?(\\d{1,2}(?:\\s*(?:,|and|-)\\s*\\d{1,2})*)";
const WHEN = "(?: (?:myself|already|just now|now|today|yesterday|this morning|last night|from my (?:own )?(?:email|e-mail|gmail|outlook|mail|phone)))*";
const lower = (s: string) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[!?.]+\s*$/, "").replace(/\s+/g, " ").trim();
const numbers = (s: string) => {
  const out: number[] = [];
  for (const part of s.replace(/\s*(?:,|and)\s*/g, ",").replace(/\s*-\s*/g, "-").split(",")) {
    const [a, b] = part.split("-").map(Number);
    if (!(a >= 1) || a > 99) return null;
    for (let n = a; n <= (b && b >= a && b <= 99 ? b : a); n++) if (!out.includes(n)) out.push(n);
  }
  return out.sort((x, y) => x - y);
};
const nameOk = (n: string | undefined) => !!n && !NOT_NAME.test(n.trim()) && n.trim().split(" ").length <= 3;

// What the person said, or null when it is none of these (the rest of the chain answers it).
export function trackAsk(message: string): TrackAsk | null {
  const site = siteAsk(message);
  if (site) return { kind: "site", site };
  const raw = String(message ?? "");
  if (raw.length > 300) return null;
  const t = lower(raw).replace(/^(?:ok(?:ay)?|done|great|cool|alright|so|hey|fyi|update|btw)[,:]?\s+/, "");
  if (!t) return null;
  const ago = /yesterday|last night/.test(t) ? 1 : 0;
  let m = new RegExp(`^(?:i |ive |i've |i have )?(?:just |already |finally )?(?:sent|mailed) (?:draft |number |email |emails )?${NUMS}${WHEN}$`).exec(t);
  if (m) { const ns = numbers(m[1]); return ns ? { kind: "sent", ns, name: null, daysAgo: ago } : null; }
  if (new RegExp(`^(?:i |ive |i've |i have )?(?:just |already |finally )?sent (?:it|them|that|that one|the email|the emails|the draft|this one)${WHEN}$`).test(t)) return { kind: "sent", ns: null, name: null, daysAgo: ago };
  m = new RegExp(`^(?:i |ive |i've |i have )?(?:just |already |finally )?(?:emailed|e-mailed|sent (?:the |an |my )?(?:email|note|intro|message) to|sent it to|wrote to|reached out to) ${NAME}${WHEN}$`).exec(t);
  if (m && nameOk(m[1])) return { kind: "sent", ns: null, name: m[1], daysAgo: ago };
  m = new RegExp(`^${NAME} (?:replied|wrote back|responded|answered|got back to me|emailed me back|answered me|replied to me|said yes|said no)(?: .*)?$`).exec(t)
    ?? new RegExp(`^(?:i )?(?:heard back from|got a reply from|got a response from|got an answer from) ${NAME}(?: .*)?$`).exec(t);
  if (m) { const who = m[1].trim(); return /^(?:she|he|they)$/.test(who) ? { kind: "replied", name: null } : nameOk(who) ? { kind: "replied", name: who } : null; }
  m = /^remind me(?: (?:in|after) (\d{1,2}|a|one|two|three) (days?|weeks?))?(?: to)? (?:follow up|follow-up|followup|check in|check back|nudge)(?: with ([a-z][a-z.' -]{0,40}?))?(?: (?:in|after) (\d{1,2}|a|one|two|three) (days?|weeks?)| (tomorrow)| (next week))?$/.exec(t);
  if (m) {
    const word = (w: string) => (/^\d+$/.test(w) ? Number(w) : ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[w]);
    const n = m[1] ? word(m[1]) * (/^w/.test(m[2]) ? 7 : 1) : m[4] ? word(m[4]) * (/^w/.test(m[5]) ? 7 : 1) : m[6] ? 1 : m[7] ? 7 : null;
    const who = m[3]?.trim() ?? null;
    if (who && !nameOk(who) && !/^(?:her|him|them)$/.test(who)) return null;
    return { kind: "remind", name: who && !/^(?:her|him|them)$/.test(who) ? who : null, days: n };
  }
  m = new RegExp(`^(?:no reminders?|(?:please )?(?:don't|do not|dont) remind me(?: about ${NAME})?|(?:cancel|remove|drop|turn off) (?:the |my )?(?:follow-?up )?reminders?(?: (?:for|about|to follow up with) ${NAME})?|no need to remind me|stop reminding me(?: about ${NAME})?)$`).exec(t);
  if (m) { const who = m[1] ?? m[2] ?? m[3] ?? null; return { kind: "no_remind", name: who && nameOk(who) ? who : null }; }
  if (/^(?:who (?:have i|did i|i've|ive|have i already) (?:reached out to|emailed|contacted|written to|written|sent emails? to)(?: so far| yet| already)?|(?:show|list|see)(?: me)? (?:my |the )?(?:networking(?: status| tracker| list| so far)?|people i(?:'ve| have)? (?:emailed|reached out to|contacted)|who i(?:'ve| have)? (?:emailed|reached out to|contacted))|(?:my )?networking (?:status|tracker|so far)|where (?:am i|do i stand) (?:with|on) (?:my )?(?:networking|outreach)|(?:what's|whats|what is) the status of my (?:networking|outreach)(?: emails)?)$/.test(t)) return { kind: "list" };
  m = new RegExp(`^(?:(?:please|can you|could you|pls) )?(?:follow up with|follow-up with|followup with|draft (?:a |the |my )?follow-?up (?:to|for|with)|write (?:a |the |my )?follow-?up (?:to|for)|nudge) ${NAME}(?: (?:for me|please|again))?$`).exec(t);
  if (m && nameOk(m[1])) return { kind: "follow", name: m[1] };
  return null;
}
const LINKEDIN = /\blinked ?in\b|\beasy ?apply\b|\bin-?mails?\b/;
// Any ACTION on LinkedIn: messaging, connecting, endorsing, posting, commenting, following, applying (Easy Apply), and
// any ask routed "via / on / through LinkedIn". Their own export stays theirs (LI_OWN).
const LI_ACT = /\b(?:message|msg|dm|inmail|in-mail|connect|link (?:my|your|to)|hook up|add (?:her|him|them|everyone|people|[a-z]+) on|invite|send (?:an? |the |my |some )?(?:connection(?: request)?s?|invites?|invitations?|messages?|notes?|dms?|inmails?|requests?)|connection requests?|reach out|ping|scrape|crawl|automate|auto-?(?:connect|message|apply|send)|pull (?:people|profiles|contacts|emails)|find (?:people|profiles|recruiters|alumni|emails?)|search|look up|log ?in|sign ?in|endorse|endorsements?|recommend (?:me|her|him|them)|write (?:me |her |him )?(?:a )?recommendation|post|publish|share|comment|like (?:her|his|their|the|a|my) post|follow(?! ?-?up)|apply|easy ?apply|submit)\b|\b(?:via|through|thru|over|using) linked ?in\b|\beasy ?apply\b/;
// Their own: the export, or their own profile link ("my linkedin is <link>", "here's my linkedin: <link>"). "here is" alone
// is not theirs ("here is a job on linkedin, apply to it" is an ask; scenarios-sites.test.ts).
const LI_OWN = /\b(?:connections\.csv|export(?:ed|s)?|download(?:ed)? (?:my|the) (?:linkedin )?(?:data|connections|contacts|export)|copy of (?:my|your) data|get a copy|here(?: are|'s| is) my|these are my|attached (?:are |is )?my|my linkedin (?:profile|url|link|page|is)|my profile (?:link|url))\b/;
// Common misspellings of LinkedIn read as LinkedIn ("message maya on linkedn", "apply via linked-in").
const LI_TYPO = /\b(?:linked[ -]in|linkedn|linkdin|linkedln|linkden|linkdn|lnkdin|linkeding|linkdein)\b/g;
// A question about what the person should do themselves ("how do I message recruiters on LinkedIn?", "should I apply on
// Indeed or the company site?", "how should I update my linkedin headline?") asks for advice, not for Trainee to act; one
// that hands the act to Trainee ("can you", "for me", "please") is an ask.
const ADVICE = /^(?:(?:so|ok|okay|and|but|also|hey|quick question|q|honestly)[,:]?\s+)*(?:how (?:do|can|should|would|could) i|should i|would i|is it (?:ok|okay|worth|smart|good|bad|weird|fine|normal|appropriate|rude|better|wise|possible) (?:to|if i)|what should i|what(?:'s| is) the best way to|when should i|do i need to|any tips|tips (?:for|on)|is (?:it|linkedin|handshake|indeed)\b[^?]* worth)\b/;
const LI_EXPORT = /\b(?:connections\.csv|export(?:ed|s)?|download(?:ed)?|copy of (?:my|your) data|get a copy|connections|contacts)\b/;
const HANDED = /\b(?:for me|you|u|ur|please|pls|plz|yourself)\b/;
// Indeed and Handshake named as the place of the action ("on Indeed", "through my Handshake", "Indeed's Easy Apply",
// "Handshake jobs"), never the plain words ("indeed I did", "a firm handshake").
const SITE_WORD: [Exclude<Site, "LinkedIn">, RegExp][] = [
  ["Indeed", /\b(?:on|via|through|thru|over|using|from|at|in|with) (?:my |the |your )?indeed\b|\bindeed(?:'s)? (?:easy ?apply|jobs?|postings?|listings?|ads?|messages?|inbox|account|profile|resume|recruiters?|employers?)\b|\bindeed\.[a-z]|\b(?:search|browse|scan|scrape|crawl|check|use) (?:my )?indeed\b/],
  ["Handshake", /\b(?:on|via|through|thru|over|using|from|at|in|with) (?:my |the |your |our )?(?:join ?)?handshake\b|\b(?:join ?)?handshake(?:'s)? (?:jobs?|postings?|listings?|messages?|inbox|account|profile|app|recruiters?|employers?|events?|fairs?)\b|\bjoinhandshake\b/],
];
const SITE_ACT = new RegExp(`${LI_ACT.source}|\\b(?:applying|application|messages?)\\b`);
const LINK = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'()]*)?/gi;
const LABEL_SITE: Record<string, Site> = { linkedin: "LinkedIn", lnkd: "LinkedIn", licdn: "LinkedIn", indeed: "Indeed", indeedemail: "Indeed", indeedmail: "Indeed", joinhandshake: "Handshake" };
// The site a link is on when it is one of the three (any suffix or depth, as career_people_sites.ts neverOpen), else null.
export function siteOfLink(url: string): Site | null {
  let host: string;
  try { host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname; } catch { return null; }
  if (!neverOpen(host)) return null;
  for (const l of host.toLowerCase().split(".").slice(0, -1)) if (LABEL_SITE[l]) return LABEL_SITE[l];
  return null;
}
// Whether the message asks Trainee to do something on LinkedIn, Indeed or Handshake (a link to one of them pasted with
// no employer link beside it, or an action named on one of them), and which. Their own LinkedIn export stays theirs.
export function siteAsk(message: string): Site | null {
  const raw = String(message ?? "").slice(0, 4000);
  if (!lower(raw)) return null;
  const unmailed = raw.replace(/\S+@\S+/g, " ");
  const links = (unmailed.match(LINK) ?? []).map((u) => u.replace(/[.,;:!?)\]>"']+$/, ""));
  const sites = links.map(siteOfLink);
  // The words, without the links: a tracking parameter naming a site ("?utm_source=linkedin") is not the site named.
  const t = lower(unmailed.replace(LINK, " ")).replace(LI_TYPO, "linkedin");
  const own = LI_OWN.test(t);
  // An employer's own page beside it is the way in: that turn reads it, and never opens the others.
  const employer = sites.some((s, i) => !s && /\//.test(links[i]));
  if (sites.some((s) => s) && employer) return null;
  const linked = sites.find((s): s is Site => !!s);
  // A link to one of them is refused when it comes with an action or alone ("<link>", "this one <link> please"); a
  // LinkedIn profile link that is their own ("my linkedin is <link>") is theirs.
  if (linked) {
    const profileOnly = links.every((u, i) => sites[i] !== "LinkedIn" || /linkedin\.[a-z.]+\/(?:in|pub)\//i.test(u));
    if (linked === "LinkedIn" && own && profileOnly && !LI_ACT.test(t.replace(/\bmy linkedin (?:profile|url|link|page)\b/g, " "))) return null;
    const words = t.replace(/\b(?:please|pls|plz|thanks|thank you|thx|asap|for me|now|this|that|one|here|ok|okay|hey|hi|the|job|link|posting)\b/g, " ")
      .split(" ").filter((x) => /[a-z0-9]/.test(x)).length;
    return SITE_ACT.test(t) || words <= 3 ? linked : null;
  }
  // Advice the person asked for themselves, never an act handed to Trainee.
  if (ADVICE.test(t) && !HANDED.test(t)) return null;
  // An apply ask beside the employer's own posting link applies there ("apply to the analyst job at Indeed <careers link>").
  if (employer && !/\b(?:message|msg|dm|inmail|connect|reach out|ping|invite|endorse|post|scrape|crawl|search|log ?in|sign ?in)\b/.test(t)) return null;
  // In words, only their export is theirs ("here are my linkedin connections, who should I email?"); "here's my linkedin,
  // connect me with ..." is still an ask.
  const li = LINKEDIN.test(t) && LI_ACT.test(t) && !(own && LI_EXPORT.test(t));
  if (li && /\blinked ?in\b/.test(t)) return "LinkedIn";
  for (const [site, rx] of SITE_WORD) if (rx.test(t) && SITE_ACT.test(t)) return site; // "Easy Apply ... on Indeed" is Indeed's
  return li ? "LinkedIn" : null;
}

export interface TrackDeps {
  message: string; userId: string; threadId: string; now: number;
  store: OutreachStore; events?: EventStore | null;
  facts: unknown[]; model: ModelFn | null;
  contactsWithEmail?: (name: string) => string[] | Promise<string[]>; // "Maya Chen at Stripe" lines from the person's own contacts, for the LinkedIn answer
  // Architect ruling R2: never promise a reminder the system won't deliver. reminderPush is CAREER_OUTREACH_FOLLOWUPS=on
  // (read by the caller, never here); textingChannel is the channel a queued reminder would reach them on, or null (a
  // web-only person: career_outbox_claim never delivers to someone with no channel contact).
  reminderPush?: boolean;
  textingChannel?: () => Promise<string | null>;
}
const CHANNEL_NAME: Record<string, string> = { imessage: "iMessage/SMS", whatsapp: "WhatsApp", telegram: "Telegram" };
// How the reminder will reach them, said truthfully: texted on their channel when the scheduled push is on and they have
// one; otherwise no message is sent, and the follow-up shows as due in their networking list.
async function reminderWords(o: TrackDeps, due: string): Promise<{ promise: string; pushed: boolean }> {
  const ch = o.reminderPush && o.textingChannel ? await o.textingChannel().catch(() => null) : null;
  if (ch) return { promise: `I'll text you a reminder on ${CHANNEL_NAME[ch] ?? ch} on ${due} to follow up if there's no reply by then.`, pushed: true };
  const why = o.reminderPush ? "no texting channel (iMessage/SMS, WhatsApp or Telegram) is linked to your account" : "follow-up reminders aren't switched on yet";
  return { promise: `I won't message you a reminder: ${why}. From ${due}, "who have I reached out to" shows this follow-up as due.`, pushed: false };
}
export interface TrackResult { reply: string; intent: string; status: string; parts?: string[] }

const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const dayText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
const who = (d: OutreachDraft) => `${d.recipient.name}${d.recipient.firm ? ` (${d.recipient.firm})` : ""}`;
// How far an email got: a reply outranks a send, a send outranks an approval or a waiting draft (a follow-up drafted
// after a sent email never hides that it was sent), and anything outranks a cancelled or replaced draft.
const RANK: Record<string, number> = { replied: 5, bounced: 4, sent: 4, sending: 4, approved: 3, shown: 2, failed: 1, skipped: 0 };
// The furthest-along draft per person (by address), newest first among equals; people in order of their newest draft.
function people(rows: OutreachDraft[]): OutreachDraft[] {
  const best = new Map<string, OutreachDraft>();
  for (const d of rows) {
    const k = d.recipient.email.toLowerCase(), x = best.get(k);
    if (!x || (RANK[d.status] ?? 0) > (RANK[x.status] ?? 0)) best.set(k, d);
  }
  return [...best.values()];
}
// The person's drafts to someone of this name: the full name, or the first name alone when only one person has it.
function byName(rows: OutreachDraft[], name: string): { match: OutreachDraft[]; many: string[] } {
  const want = plain(name), first = want.split(" ")[0];
  const exact = rows.filter((d) => plain(d.recipient.name) === want);
  const pool = exact.length ? exact : rows.filter((d) => (want.includes(" ") ? plain(d.recipient.name).startsWith(`${want} `) : plain(d.recipient.name).split(" ")[0] === first));
  const many = [...new Set(pool.map((d) => d.recipient.email.toLowerCase()))];
  return { match: pool, many: many.length > 1 ? [...new Set(pool.map((d) => `${d.recipient.name} <${d.recipient.email}>`))] : [] };
}
const statusLine = (d: OutreachDraft, f: Followup | undefined, now: number): string => {
  const at = d.sent_at ? shortDay(Date.parse(d.sent_at)) : null;
  const base = d.status === "shown" ? `drafted, waiting for your approval (draft ${d.n})`
    : d.status === "approved" ? `approved, not sent yet: send it yourself, then say "sent ${d.n}"`
    : d.status === "sending" ? "being sent"
    : d.status === "sent" ? (d.result === "sent_by_you" ? `sent by you${at ? ` on ${at}` : ""}` : `sent from your Gmail${at ? ` on ${at}` : ""}`)
    : d.status === "replied" ? `replied${at ? ` (you wrote on ${at})` : ""}`
    : d.status === "bounced" ? "bounced: the address didn't work"
    : d.status === "failed" ? "not sent: sending failed"
    : d.result === "cancelled" ? "not sent: you cancelled it" : d.result === "replaced" ? "not sent: replaced by a newer draft" : "not sent: dropped";
  const due = f && !f.fired_at && d.status === "sent" ? `; follow-up reminder ${Date.parse(f.due_at) <= now ? "due now" : `on ${dayText(Date.parse(f.due_at))}`}` : "";
  return `- ${who(d)} <${d.recipient.email}>: ${base}${due}`;
};

export async function trackTurn(o: TrackDeps): Promise<TrackResult | null> {
  const ask = trackAsk(o.message);
  if (!ask) return null;
  if (ask.kind === "site") return await siteTurn(o, ask.site);
  if (!o.store.history) return null;
  const rows = await o.store.history(o.userId, 500);
  // Nothing on record to track: only the list answers (plainly); every other ask is someone else's (the router's).
  if (!rows.length) return ask.kind === "list" ? { reply: `You haven't reached out to anyone through Trainee yet: there are no networking emails on record. Send me your contacts (a LinkedIn Connections.csv or rows like Name,Company,Email), then say "email <name> at <firm> about <what you want to ask>".`, intent: TRACK_INTENT, status: "empty" } : null;
  const follow = o.store.followups ? await o.store.followups(o.userId) : [];
  if (ask.kind === "list") return listTurn(o, rows, follow);
  if (ask.kind === "sent") return await sentTurn(o, ask, rows, follow);
  if (ask.kind === "replied") return await repliedTurn(o, ask.name, rows, follow);
  if (ask.kind === "remind") return await remindTurn(o, ask, rows, follow);
  if (ask.kind === "no_remind") return await noRemindTurn(o, ask.name, rows, follow);
  if (ask.kind === "follow") return await followTurn(o, ask.name, rows, follow);
  return null;
}

function listTurn(o: TrackDeps, rows: OutreachDraft[], follow: Followup[]): TrackResult {
  const ps = people(rows);
  const reached = ps.filter((d) => ["sent", "replied", "bounced", "sending"].includes(d.status)).length;
  const replied = ps.filter((d) => d.status === "replied").length;
  const shown = ps.slice(0, 25).map((d) => {
    const next = rows.find((x) => x.recipient.email.toLowerCase() === d.recipient.email.toLowerCase() && x.id !== d.id && x.created_at > d.created_at && ["shown", "approved"].includes(x.status));
    return statusLine(d, follow.find((f) => f.draft_id === d.id), o.now) + (next && ["sent", "replied"].includes(d.status) ? `; a follow-up is ${next.status === "shown" ? "drafted, waiting for your approval" : "approved, not sent yet"} (draft ${next.n})` : "");
  });
  return {
    reply: [`From what's on record in Trainee: ${ps.length} ${ps.length === 1 ? "person" : "people"}, ${reached} emailed, ${replied} replied. Trainee can't read your inbox, so a reply counts here once you tell me ("Maya replied").`,
      ...shown, ...(ps.length > 25 ? [`and ${ps.length - 25} more.`] : [])].join("\n"),
    intent: TRACK_INTENT, status: "listed",
  };
}

async function setFollow(o: TrackDeps, follow: Followup[], items: Followup[]) {
  if (!o.store.saveFollowups) return;
  const ids = new Set(items.map((x) => x.draft_id));
  await o.store.saveFollowups(o.userId, [...follow.filter((x) => !ids.has(x.draft_id)), ...items]);
}
const followOf = (d: OutreachDraft, sentAt: number, dueAt: number, now: number, asked: boolean): Followup => ({
  draft_id: d.id, name: d.recipient.name, firm: d.recipient.firm, email: d.recipient.email, subject: d.subject,
  sent_at: new Date(sentAt).toISOString(), due_at: new Date(dueAt).toISOString(), set_at: new Date(now).toISOString(), fired_at: null, asked,
});

async function sentTurn(o: TrackDeps, ask: Extract<TrackAsk, { kind: "sent" }>, rows: OutreachDraft[], follow: Followup[]): Promise<TrackResult | null> {
  let pick: OutreachDraft[];
  const latest = rows.filter((d) => d.batch_id === rows[0].batch_id).sort((a, z) => a.n - z.n);
  if (ask.ns) {
    const missing = ask.ns.filter((n) => !latest.some((d) => d.n === n));
    if (missing.length) return { reply: `Your newest drafts are ${latest.map((d) => `${d.n} ${who(d)}`).join(", ")}; there is no ${missing.join(", ")}. Nothing was marked sent.`, intent: TRACK_INTENT, status: "not_in_batch" };
    pick = latest.filter((d) => ask.ns!.includes(d.n));
  } else if (ask.name) {
    const { match, many } = byName(rows, ask.name);
    if (!match.length) return null;
    if (many.length) return { reply: `More than one ${ask.name} is on record: ${many.join("; ")}. Say "sent" and the number of the draft, or the full name. Nothing was marked sent.`, intent: TRACK_INTENT, status: "which" };
    // The newest one not sent yet (a follow-up they just sent), else the furthest along (said to be already sent).
    pick = [match.find((d) => d.status === "shown" || d.status === "approved") ?? people(match)[0]];
  } else {
    const approved = latest.filter((d) => d.status === "approved"), waiting = latest.filter((d) => d.status === "shown");
    pick = approved.length ? approved : waiting.length === 1 ? waiting : [];
    if (!pick.length) return { reply: `Which one did you send? Say "sent" and its number (your newest drafts: ${latest.map((d) => `${d.n} ${who(d)} (${d.status === "skipped" ? "cancelled" : d.status})`).join(", ")}). Nothing was marked sent.`, intent: TRACK_INTENT, status: "which" };
  }
  const at = o.now - ask.daysAgo * DAY, marked: OutreachDraft[] = [], already: string[] = [];
  for (const d of pick) {
    if (["sent", "sending", "replied", "bounced"].includes(d.status)) { already.push(`${who(d)} (already ${d.status === "replied" ? "replied" : "marked sent"})`); continue; }
    const done: OutreachDraft = { ...d, status: "sent", sent_at: new Date(at).toISOString(), result: "sent_by_you" };
    if (await o.store.update(o.userId, done, { status: d.status })) {
      marked.push(done);
      await recordOutreach(o.events, o.userId, "outreach_sent", done, at, { by: "you" });
    } else already.push(`${who(d)} (it changed just now; say it again)`);
  }
  const items = marked.map((d) => followOf(d, at, at + FOLLOWUP_DAYS * DAY, o.now, false));
  await setFollow(o, follow, items);
  if (!marked.length) return { reply: `Nothing new was marked sent: ${already.join("; ")}.`, intent: TRACK_INTENT, status: "already" };
  const due = items[0] ? dayText(Date.parse(items[0].due_at)) : "";
  const one = marked.length === 1;
  const words = await reminderWords(o, due);
  return {
    reply: [`Marked sent by you: ${marked.map((d) => `${d.n} ${who(d)}`).join(", ")}, ${ask.daysAgo ? "yesterday" : "today"}. Trainee sent nothing itself and will never send ${one ? "it" : "them"} again.${already.length ? ` Not changed: ${already.join("; ")}.` : ""}`,
      `${words.promise} Say "${marked[0].recipient.name.split(" ")[0]} replied" when ${one ? "they do" : "someone does"}, "remind me in 3 days" for another day, or "no reminder".`].join("\n"),
    intent: TRACK_INTENT, status: "marked_sent",
  };
}

// The draft a name, or "she/he/they", means among what was sent: the newest one sent.
function sentTo(rows: OutreachDraft[], name: string | null): { d: OutreachDraft | null; many: string[]; none: boolean } {
  const live = rows.filter((d) => d.status !== "skipped");
  if (!name) { const s = live.filter((d) => ["sent", "replied"].includes(d.status)); return { d: s[0] ?? null, many: [], none: !s.length }; }
  const { match, many } = byName(live, name);
  if (many.length) return { d: null, many, none: false };
  return { d: people(match)[0] ?? null, many: [], none: !match.length };
}

async function repliedTurn(o: TrackDeps, name: string | null, rows: OutreachDraft[], follow: Followup[]): Promise<TrackResult | null> {
  const r = sentTo(rows, name);
  if (r.none) return null;
  if (r.many.length) return { reply: `More than one ${name} is on record: ${r.many.join("; ")}. Say the full name. Nothing was changed.`, intent: TRACK_INTENT, status: "which" };
  const d = r.d!;
  if (d.status === "replied") return { reply: `${who(d)} is already on record as replied.`, intent: TRACK_INTENT, status: "already" };
  if (d.status === "shown" || d.status === "approved") return { reply: `Your email to ${who(d)} isn't marked sent yet (${d.status === "shown" ? "it's still waiting for your approval" : "approved, not sent"}). If you sent it, say "sent ${d.n}" first; nothing was changed.`, intent: TRACK_INTENT, status: "not_sent" };
  if (!(await o.store.update(o.userId, { ...d, status: "replied", result: d.result === "sent_by_you" ? "sent_by_you" : "reply_told" }, { status: d.status }))) return { reply: `That record changed just now; say it again.`, intent: TRACK_INTENT, status: "changed" };
  await recordOutreach(o.events, o.userId, "outreach_replied", d, o.now, { by: "you told me" });
  const had = follow.find((f) => f.draft_id === d.id && !f.fired_at);
  if (had) await setFollow(o, follow, [{ ...had, fired_at: new Date(o.now).toISOString() }]);
  return { reply: `Noted: ${who(d)} replied.${had ? ` The follow-up reminder for ${d.recipient.name.split(" ")[0]} is off.` : ""}`, intent: TRACK_INTENT, status: "replied" };
}

async function remindTurn(o: TrackDeps, ask: Extract<TrackAsk, { kind: "remind" }>, rows: OutreachDraft[], follow: Followup[]): Promise<TrackResult | null> {
  const r = sentTo(rows, ask.name);
  if (r.none) return null; // not someone they wrote to through Trainee: the router answers
  if (r.many.length) return { reply: `More than one ${ask.name} is on record: ${r.many.join("; ")}. Say the full name. No reminder was set.`, intent: TRACK_INTENT, status: "which" };
  const d = r.d!, first = d.recipient.name.split(" ")[0];
  if (d.status === "replied") return { reply: `${who(d)} already replied, so no follow-up reminder was set.`, intent: TRACK_INTENT, status: "replied" };
  if (d.status !== "sent") return { reply: `Your email to ${who(d)} isn't sent yet, so there's nothing to follow up on. Once you've sent it, say "sent ${d.n}" and I'll set a follow-up for ${ask.days ?? FOLLOWUP_DAYS} days later. No reminder was set.`, intent: TRACK_INTENT, status: "not_sent" };
  const days = Math.min(60, Math.max(1, ask.days ?? FOLLOWUP_DAYS));
  const sentAt = Date.parse(d.sent_at ?? "") || o.now;
  await setFollow(o, follow, [followOf(d, sentAt, o.now + days * DAY, o.now, true)]);
  const day = dayText(o.now + days * DAY), words = await reminderWords(o, day);
  return { reply: words.pushed
      ? `I'll text you a reminder on ${day} to follow up with ${who(d)}, unless you tell me ${first} replied first. Say "no reminder" to drop it.`
      : `Follow-up with ${who(d)} set for ${day}. ${words.promise} Say "${first} replied" if they do first, or "no reminder" to drop it.`,
    intent: TRACK_INTENT, status: "reminder_set" };
}

async function noRemindTurn(o: TrackDeps, name: string | null, rows: OutreachDraft[], follow: Followup[]): Promise<TrackResult | null> {
  const open = follow.filter((f) => !f.fired_at);
  if (!open.length) return follow.length || rows.length ? { reply: "There's no follow-up reminder waiting, so nothing changed.", intent: TRACK_INTENT, status: "none" } : null;
  let drop = open;
  if (name) {
    const want = plain(name);
    drop = open.filter((f) => plain(f.name) === want || plain(f.name).split(" ")[0] === want.split(" ")[0]);
    if (!drop.length) return { reply: `There's no follow-up reminder for ${name}. Waiting: ${open.map((f) => f.name).join(", ")}.`, intent: TRACK_INTENT, status: "none" };
  } else {
    // "no reminder" right after one was set drops that one; otherwise the newest one set.
    drop = [open.sort((a, z) => z.set_at.localeCompare(a.set_at))[0]];
  }
  await setFollow(o, follow, drop.map((f) => ({ ...f, fired_at: new Date(o.now).toISOString(), due_at: f.due_at })));
  return { reply: `No reminder: dropped the follow-up reminder for ${drop.map((f) => f.name).join(", ")}.`, intent: TRACK_INTENT, status: "reminder_dropped" };
}

async function followTurn(o: TrackDeps, name: string, rows: OutreachDraft[], follow: Followup[]): Promise<TrackResult | null> {
  const r = sentTo(rows, name);
  if (r.none) return null;
  if (r.many.length) return { reply: `More than one ${name} is on record: ${r.many.join("; ")}. Say the full name. Nothing was drafted.`, intent: TRACK_INTENT, status: "which" };
  const d = r.d!;
  if (d.status === "replied") return { reply: `${who(d)} already replied (on record), so no follow-up is due. Nothing was drafted.`, intent: TRACK_INTENT, status: "replied" };
  if (d.status !== "sent") return { reply: `Your first email to ${who(d)} isn't sent yet (${d.status === "shown" ? "waiting for your approval" : d.status === "approved" ? "approved, waiting for you to send it" : d.status}). Send that one first; nothing was drafted.`, intent: TRACK_INTENT, status: "not_sent" };
  const pendingFollow = rows.find((x) => x.recipient.email.toLowerCase() === d.recipient.email.toLowerCase() && x.created_at > d.created_at && ["shown", "approved"].includes(x.status));
  // The waiting follow-up stays the thread's last word when it is the newest batch, so "send 1" or "send none" answers it.
  if (pendingFollow) return { reply: `You already have a follow-up to ${who(d)} waiting (draft ${pendingFollow.n}, ${pendingFollow.status === "shown" ? "not approved yet" : "approved, not sent"}). Nothing new was drafted.${pendingFollow.batch_id === rows[0].batch_id && pendingFollow.status === "shown" ? ` Say "send ${pendingFollow.n}" to approve it as shown, or "send none".` : ""}`,
    intent: pendingFollow.batch_id === rows[0].batch_id ? OUTREACH_INTENT : TRACK_INTENT, status: "already" };
  // OUTREACH SCENARIOS (2026-10-30): anyone's opt-out list and the bounce list, not only the person's own.
  const blocked = (await blockedAddresses(o.store, o.userId, [d.recipient.email])).get(d.recipient.email.trim().toLowerCase());
  if (blocked) return { reply: blocked === "bounced" ? `${who(d)}'s address bounced before, so no one emails it again; nothing was drafted.` : `${who(d)} asked not to be contacted, so nothing was drafted.`, intent: TRACK_INTENT, status: "do_not_contact" };
  const facts = confirmed(o.facts as unknown[]);
  if (!facts.length) return { reply: "I write only from facts you've confirmed, and there are none on record, so nothing was drafted. Paste your resume here and confirm it, then ask again.", intent: TRACK_INTENT, status: "no_facts" };
  if (!o.model) return { reply: `Drafting emails isn't switched on here yet, so no follow-up was written or sent. Your first email to ${who(d)} went on ${shortDay(Date.parse(d.sent_at ?? "") || o.now)} ("${d.subject}").`, intent: TRACK_INTENT, status: "drafting_off" };
  const prefs = await o.store.prefs(o.userId);
  if (!prefs.signature) return { reply: `How do you sign your emails? Send your name the way you want it at the bottom, then say "follow up with ${d.recipient.name.split(" ")[0]}" again.`, intent: "career_outreach_signature", status: "needs_signature" };
  const when = shortDay(Date.parse(d.sent_at ?? "") || o.now);
  const topic = `a short, polite follow-up to my email of ${when} ("${d.subject}"), since I haven't heard back`;
  // A follow-up on a thread already sent: not a first email, so the personalization engine's first-email rules don't apply.
  const { personal: _first, facts: _f, ...recipient } = d.recipient;
  const x = await draftFor({ model: o.model, facts, r: recipient, topic, personal: false });
  if (!x.ok) return { reply: `I couldn't write a follow-up to ${who(d)} that uses only what's on record (${x.why === "model" ? "the writing model didn't answer" : x.detail.slice(0, 2).join("; ")}). Nothing was drafted.`, intent: TRACK_INTENT, status: "not_drafted" };
  const draft = { n: 1, recipient, subject: x.subject, body: x.body, footer: footerOf(prefs.signature), shared: x.shared, status: "shown" as const, hash: "",
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  draft.hash = await payloadHash(messageOf(draft));
  const [saved] = await o.store.saveBatch(o.userId, o.threadId, [draft], o.now);
  await recordOutreach(o.events, o.userId, "outreach_drafted", saved, o.now, { from: "chat", follow_up_of: d.id });
  // The reminder for the first email is answered by this draft.
  const had = follow.find((f) => f.draft_id === d.id && !f.fired_at);
  if (had) await setFollow(o, follow, [{ ...had, fired_at: new Date(o.now).toISOString() }]);
  const head = `Drafted a follow-up to ${who(d)} (your first email went on ${when}). Nothing is sent until you approve it.`;
  const parts = [head, ...batchMessages([saved])];
  return { reply: parts.join("\n\n"), intent: OUTREACH_INTENT, status: "drafted", parts };
}

async function siteTurn(o: TrackDeps, site: Site): Promise<TrackResult> {
  const intent = site === "LinkedIn" ? LINKEDIN_INTENT : SITE_INTENT;
  const why = site === "LinkedIn" ? "LinkedIn doesn't allow automated activity on accounts" : `Trainee doesn't automate ${site}`;
  // Applying on the site (Easy Apply included) is never done for them: the employer's own posting is the way in.
  if (/\b(?:apply|applying|application|easy ?apply|submit)\b/i.test(o.message) && !/\b(?:message|msg|dm|inmail|connect|reach out|endorse)\b/i.test(o.message)) {
    return { reply: `I don't apply on ${site} for you${site === "LinkedIn" ? " (Easy Apply included)" : ""}, and I never sign in to ${site} or run anything on it: ${why}. Nothing was sent or done on ${site}. Send me the job's link on the employer's own careers site (or its Greenhouse, Lever or Ashby page) and I'll prepare the application there for your approval.`, intent, status: "refused" };
  }
  const m = /\b(?:message|msg|dm|inmail|connect with|add|invite|reach out to|endorse|ping)\s+([a-z][a-z.'-]*(?: [a-z][a-z.'-]*)?)\b/i.exec(o.message);
  const name = m && !/^(?:everyone|everybody|people|all|recruiters?|employers?|them|him|her|my|the|someone|anyone|a|an|with|to|on|via)$/i.test(m[1].split(" ")[0]) ? m[1].split(" ")[0] : null;
  const known = name && o.contactsWithEmail ? await Promise.resolve(o.contactsWithEmail(name)).catch(() => [] as string[]) : [];
  const first = known.length ? known[0].split(" ")[0] : name;
  const instead = known.length
    ? `I can write ${first} an email instead, for you to approve: ${known.slice(0, 3).join("; ")} is in your contacts with an address. Say "email ${name} at <firm> about <what you want to ask>".`
    : `I can draft an email to anyone in your contacts who has an address, for you to approve and send yourself. To see who you know at a firm, send me your LinkedIn connections export (LinkedIn: Settings, Data privacy, Get a copy of your data, Connections) and ask "who do I know at <firm>".`;
  return { reply: `I don't message, connect, search or post on ${site} for you, and I never sign in to ${site} or run anything on it: ${why}. Nothing was sent or done on ${site}. ${instead}`, intent, status: "refused" };
}

// ------------------------------------------------------------------------------------------------ the scheduled run
// Each reminder that is due fires once: one message to the person's outbox (key followup:outreach:<draft>, so a second
// run can never queue it twice), only while the email is still on record as sent with no reply; a reply, a bounce or a
// cancel turns it off without a message. A paused, opted-out or erased person gets nothing (kept for when they resume).
type RunOpts = { store: OutreachStore; outbox: Outbox; now: number; quiet?: (userIds: string[]) => Promise<Set<string>>;
  batch?: number; leaseMs?: number; until?: number; limit?: number };
// Scale (owner, 2026-10-27: no product volume limit; work at 100,000 people): people are claimed in leased batches
// (claimDueFollowups, FOR UPDATE SKIP LOCKED), oldest due first, so any number of instances run side by side on disjoint
// people, and the run loops until no one is left due. `batch` sizes one claim; `until` is the instance's own wall clock
// (an edge function's time limit), never a cap on the work: what a run doesn't reach stays due, and its lease lapses
// for the next run. A person whose turn failed keeps their lease until it lapses, then is claimed again.
export const FOLLOWUP_CLAIM_BATCH = 200, FOLLOWUP_LEASE_MS = 5 * 60_000;
export async function runOutreachFollowups(o: RunOpts) {
  const stats = { due: 0, queued: 0, off: 0, quiet: 0, errors: 0, people: 0, claims: 0, error: null as string | null };
  if (!o.store.saveFollowups || !(o.store.drafts || o.store.history) || !(o.store.claimDueFollowups || o.store.allFollowups)) return stats;
  let once = false;
  const held: { user_id: string; items: Followup[] }[] = []; // paused people this run claimed: released once it ends
  const claim = o.store.claimDueFollowups
    ? () => o.store.claimDueFollowups!(o.now, o.batch ?? FOLLOWUP_CLAIM_BATCH, o.leaseMs ?? FOLLOWUP_LEASE_MS)
    : async () => (once ? [] : (once = true, await o.store.allFollowups!(o.limit ?? Number.MAX_SAFE_INTEGER)));
  for (;;) {
    if (o.until && Date.now() >= o.until) break;
    const all = await claim();
    stats.claims++;
    if (!all.length) break;
    const quiet = o.quiet ? await o.quiet(all.map((x) => x.user_id)).catch(() => new Set(all.map((x) => x.user_id))) : new Set<string>();
    for (const { user_id, items } of all) {
      const due = items.filter((f) => !f.fired_at && Date.parse(f.due_at) <= o.now);
      if (!due.length) continue;
      stats.people++;
      stats.due += due.length;
      if (quiet.has(user_id)) { stats.quiet += due.length; held.push({ user_id, items }); continue; } // kept; released after the loop
      try {
        // Only the drafts these reminders are about (by id), never the person's whole history.
        const rows = o.store.drafts ? await o.store.drafts(user_id, due.map((f) => f.draft_id)) : await o.store.history!(user_id, 500);
        const done: Followup[] = [];
        for (const f of due) {
          const d = rows.find((x) => x.id === f.draft_id);
          if (!d || d.status !== "sent") { stats.off++; done.push({ ...f, fired_at: new Date(o.now).toISOString() }); continue; }
          const first = f.name.split(" ")[0];
          const text = `Follow-up reminder: you emailed ${f.name}${f.firm ? ` (${f.firm})` : ""} on ${shortDay(Date.parse(f.sent_at))} ("${f.subject}"), and no reply is on record. Say "follow up with ${first}" and I'll draft a short follow-up for your approval, "${first} replied" if they did, or "no reminder".`;
          const fresh = await o.outbox.enqueue(user_id, { key: `followup:outreach:${f.draft_id}`, kind: "followup", text, at: o.now });
          if (fresh) stats.queued++;
          done.push({ ...f, fired_at: new Date(o.now).toISOString() });
        }
        const ids = new Set(done.map((x) => x.draft_id));
        await o.store.saveFollowups(user_id, [...items.filter((x) => !ids.has(x.draft_id)), ...done]);
      } catch (e) {
        stats.errors++;
        stats.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
    }
    if (!o.store.claimDueFollowups) break;
  }
  // A paused person's reminders stay as they are (unfired); releasing the lease after the loop (never inside it, which
  // would re-claim them at once) lets the next run check again whether they resumed.
  for (const x of held) await o.store.saveFollowups(x.user_id, x.items).catch(() => {});
  return stats;
}

// The scheduled run's gate (career-proactive/index.ts): follow-up reminders run only when the owner has
// turned them on (CAREER_OUTREACH_FOLLOWUPS=on). Off — the default — the run does not happen at all: no
// outbox row is queued and no reminder is marked fired, however many are due. Sending has its own switch
// (CAREER_OUTREACH_SEND); the reminders need no Gmail, so this gate stands on its own.
export async function runOutreachFollowupsGated(env: { get(k: string): string | undefined }, o: RunOpts) {
  if (env.get("CAREER_OUTREACH_FOLLOWUPS") !== "on") return undefined;
  return await runOutreachFollowups(o);
}
