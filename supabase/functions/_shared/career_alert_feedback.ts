// JOB ALERTS AS A REAL OUTCOME (2026-10-31): "less like this" / "more like 2" on the last job alert or morning message the
// person was sent, as a standing rule on their alert settings (prefs.feedback; career_alerts.ts feedbackOf; Q498). Code's,
// before the router, like the pace and undo turns: what was sent is read from the person's own delivered outbox rows (an
// alert's key names its posting; a morning message's numbered lines carry each posting's link), the posting from the
// postings on file, and the rule is the posting's company and the distinct words of its title (the words the watch did not
// ask for). Nothing is sent or applied here; the reply says exactly what will be held back or put first.
import { type AlertPrefs, type AlertSignal, words } from "./career_alerts.ts";
import type { AlertStore } from "./career_alert_store.ts";
import { saveAlertFeedback } from "./career_watch_alerts.ts";

export const ALERT_FEEDBACK_INTENT = "career_alert_feedback";
// Words that say nothing about the kind of job: level words, filler and the usual title nouns.
const PLAIN = new Set(["intern", "interns", "internship", "internships", "co", "op", "coop", "junior", "jr", "senior", "sr", "lead", "staff", "principal",
  "engineer", "engineering", "developer", "development", "software", "role", "position", "i", "ii", "iii", "the", "a", "an", "and", "of", "for", "to",
  "in", "at", "with", "on", "new", "grad", "graduate", "entry", "level", "summer", "fall", "spring", "winter", "2025", "2026", "2027", "remote", "hybrid"]);

export function parseFeedback(message: unknown): { kind: "less" | "more"; n: number | null } | null {
  const m = String(message ?? "").toLowerCase().replace(/[.!]+$/g, "").replace(/\s+/g, " ").trim()
    .match(/^(?:(?:show|send) me )?(less|fewer|more)(?: jobs| roles| ones)? like (this|that|this one|that one|these|#?(\d{1,2}))$/);
  if (!m) return null;
  return { kind: m[1] === "more" ? "more" : "less", n: m[3] ? Number(m[3]) : null };
}

export interface FeedbackDeps {
  store: Pick<AlertStore, "get" | "save">;
  // The person's last delivered job alert or morning message (career_outbox, kind alert or report), or null.
  lastSent: (userId: string) => Promise<{ key: string; kind: string; text: string } | null>;
  postingById: (id: string) => Promise<any | null>;
  postingByUrl: (url: string) => Promise<any | null>;
}
// The postings a delivered message listed, in its order.
async function listed(row: { key: string; kind: string; text: string }, d: FeedbackDeps): Promise<any[]> {
  if (row.key.startsWith("alert:")) { const p = await d.postingById(row.key.slice("alert:".length)); return p ? [p] : []; }
  const urls = [...String(row.text).matchAll(/^\s*\d+\. [^\n]*\n\s*(https:\/\/\S+)/gm)].map((m) => m[1]);
  const out: any[] = [];
  for (const u of urls) out.push(await d.postingByUrl(u));
  return out;
}
function signalOf(p: any, prefs: AlertPrefs): AlertSignal {
  const asked = new Set((prefs.interests ?? []).flatMap((i) => i.keywords).concat(prefs.keywords ?? []).flatMap((k) => words(k)));
  const company = String(p?.company ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const co = new Set(words(company));
  // "Front-End" is the watch's "frontend": two neighbours that make an asked word are the asked word, not two new ones.
  const ws = words(p?.title), skip = new Set<number>();
  for (let i = 0; i + 1 < ws.length; i++) if (asked.has(ws[i] + ws[i + 1])) { skip.add(i); skip.add(i + 1); }
  const terms = [...new Set(ws.filter((_, i) => !skip.has(i)))].filter((w) => w.length > 2 && !PLAIN.has(w) && !asked.has(w) && !co.has(w) && !/^\d+$/.test(w)).slice(0, 3);
  return { company, terms };
}

export async function alertFeedbackTurn(o: { message: string; userId: string; deps: FeedbackDeps }): Promise<{ reply: string; intent: string; status: string } | null> {
  const ask = parseFeedback(o.message);
  if (!ask) return null;
  const say = (reply: string, status: string) => ({ reply, intent: ALERT_FEEDBACK_INTENT, status });
  const row = await o.deps.store.get(o.userId);
  if (!row) return say("You don't have job alerts set up, so there's nothing to tune yet. Tell me what to watch for, like \"send me new data analyst roles in Chicago every morning\".", "no_alerts");
  const last = await o.deps.lastSent(o.userId);
  if (!last) return say("I haven't sent you any job alerts yet, so there's nothing to compare against. Once one arrives, reply \"less like 1\" or \"more like 1\".", "nothing_sent");
  const posts = await listed(last, o.deps);
  if (!posts.length) return say("I couldn't find the postings from my last alert on file anymore, so I didn't change anything.", "not_found");
  if (ask.n === null && posts.length > 1) return say(`My last message listed ${posts.length} jobs. Which one? Reply "${ask.kind} like 1" through "${ask.kind} like ${posts.length}".`, "which");
  const i = ask.n === null ? 1 : ask.n;
  if (i < 1 || i > posts.length || !posts[i - 1]) return say(`My last message listed ${posts.length === 1 ? "1 job" : `jobs 1 to ${posts.length}`}, so there's no ${i}. Nothing changed.`, "not_on_list");
  const p = posts[i - 1], sig = signalOf(p, row.prefs);
  // The write is the watch bridge's (D-032: one owner of career_alert_prefs on the live path).
  await saveAlertFeedback(o.deps.store, row, ask.kind, sig);
  const what = `${String(p.title ?? "").trim()} at ${sig.company}`;
  const like = [sig.company, ...sig.terms.map((t) => `"${t}"`)].join(" or ");
  return ask.kind === "less"
    ? say(`Got it: fewer like ${what}. From now on I'll leave out jobs at ${like} unless they're also like one you asked for more of.`, "saved")
    : say(`Got it: more like ${what}. From now on jobs at ${like} go first in your alerts.`, "saved");
}

// The production reads, over the service client.
export function supabaseFeedbackReads(admin: any): Omit<FeedbackDeps, "store"> {
  const one = async (q: any, what: string) => { const r = await q; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data?.[0] ?? null; };
  const cols = "job_id,company,title,location,url";
  return {
    lastSent: (userId) => one(admin.from("career_outbox").select("key,kind,text").eq("user_id", userId).in("kind", ["alert", "report"]).not("delivered_at", "is", null)
      .order("delivered_at", { ascending: false }).order("id", { ascending: false }).limit(1), "read your last alert"),
    postingById: (id) => one(admin.from("career_postings").select(cols).eq("job_id", id).limit(1), "read the posting"),
    postingByUrl: (url) => one(admin.from("career_postings").select(cols).eq("url", url).limit(1), "read the posting"),
  };
}
