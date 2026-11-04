// Job watches set by text, as the scheduled alerts run reads them.
//
// The chat router keeps a person's watches in 152's watch profile (the account's watch state, career_watch_kv key
// career:watch-profile:<user>). The scheduled run (career-proactive) reads career_alert_prefs. syncWatchAlerts is the
// bridge: after a turn is saved, the watch the turn left becomes the person's alert settings, each watch kept whole
// (career_alerts.ts matches a posting against one watch at a time, never one watch's role in another's city).
//   - every turn with a watch makes the stored settings agree with it (a failed write is repaired by the next turn); a
//     turn with no watch at all reads and writes nothing;
//   - a watch set, changed or resumed: saved, starting from now (postings already on the boards are never alerted), with
//     the person's zone, report hour, quiet hours and caps as they were;
//   - paused, or the last watch stopped: alerts off, the settings kept;
//   - forget everything: the settings removed.
// What a watch carries over: its role's title terms (keywords) and blockers (exclude_words), its places and remote, its
// bands (intern, new grad) as levels, its firms (only these), the firms it and the opt-out exclude.
import { type AlertInterest, type AlertPrefs, alertText, DEFAULT_PREFS, matchPosting, MAX_INSTANT_PER_DAY, postingLine } from "./career_alerts.ts";
import { type AlertRow, type AlertStore, startWatching, validPrefs } from "./career_alert_store.ts";
import { type Floor, validFloor } from "./career_floor.ts";

export const WATCH_PROFILE_KEY = (userId: string) => `career:watch-profile:${userId}`;
const DEFAULT_TZ = "America/New_York";
const BAND_LEVELS: Record<string, "intern" | "entry"> = { intern: "intern", new_grad: "entry", junior: "entry" };
const text = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const texts = (v: unknown, n = 20) => [...new Set((Array.isArray(v) ? v : []).map(text).filter((x) => x && x.length <= 60))].slice(0, n);

export type WatchSync =
  | { action: "unchanged" | "none" | "saved" | "off" | "removed" }
  | { action: "refused"; reason: string };

// Each watch of a profile, as the alerts run matches it. A profile that is not 152's, or a watch with no title term, gives none.
export function interestsFromWatch(wp: any): AlertInterest[] {
  if (!wp || wp.type !== "career_watch_profile" || !Array.isArray(wp.interests)) return [];
  const optedOut = texts(wp.opt_out?.companies);
  const out: AlertInterest[] = [];
  for (const i of wp.interests) {
    const keywords = texts(i?.role?.terms, 10).map((k) => k.toLowerCase());
    if (!keywords.length) continue;
    const f = i.filters || {};
    const levels = [...new Set(texts(f.bands).map((b) => BAND_LEVELS[b]).filter(Boolean))];
    const raw: Record<string, unknown> = {
      exclude_words: texts(i.role.blockers),
      exclude_companies: [...new Set([...texts(f.firms_exclude), ...optedOut])].slice(0, 20),
      ...(levels.length ? { levels } : {}),
    };
    const fl = validFloor(raw);
    const floor: Floor | undefined = fl.ok && Object.keys(fl.floor).length ? fl.floor : undefined;
    const companies = texts(f.firms_include);
    // SERIAL-1530: the person's stated location rides each watch, for a posting's stated country or region restriction.
    const home = text(wp.scoring_profile?.location).slice(0, 80);
    out.push({ keywords, locations: texts(f.locations, 10), remote_ok: f.remote_ok !== false, ...(floor ? { floor } : {}), ...(companies.length ? { companies } : {}), ...(home ? { home } : {}) });
  }
  return out;
}

// The profile as the person last set it, without the time it was written.
const same = (a: any, b: any) => JSON.stringify(a ? { ...a, updated_at: null } : null) === JSON.stringify(b ? { ...b, updated_at: null } : null);

// Every turn that has a watch makes the stored settings agree with that watch, whatever the last write did: a write that
// failed (the turn said "paused" and the row stayed on) is repaired by the next turn, not left on. A row the person's
// watches made (it has interests) follows the watch; settings made elsewhere follow it only on a turn that changed it.
export async function syncWatchAlerts(o: {
  userId: string; before: Record<string, unknown> | null | undefined; after: Record<string, unknown> | null | undefined;
  erased?: boolean; store: AlertStore; now: number;
}): Promise<WatchSync> {
  if (o.erased) {
    if (!o.store.remove) return { action: "refused", reason: "this alert store cannot remove settings" };
    await o.store.remove(o.userId);
    return { action: "removed" };
  }
  const key = WATCH_PROFILE_KEY(o.userId), was = o.before?.[key] ?? null, now = o.after?.[key] ?? null;
  if (!was && !now) return { action: "unchanged" }; // no watch, ever: nothing to agree with (the alerts run removes a stale copy)
  const changed = !same(was, now), prev = await o.store.get(o.userId);
  const interests = interestsFromWatch(now), active = interests.length > 0 && !(now as any)?.opt_out?.global;
  if (!active) {
    if (prev && prev.prefs.on && (prev.prefs.interests?.length || changed)) {
      await o.store.save({ ...prev, prefs: { ...prev.prefs, on: false } });
      return { action: "off" };
    }
    return { action: prev ? "unchanged" : "none" };
  }
  if (prev && prev.prefs.on && JSON.stringify(prev.prefs.interests ?? null) === JSON.stringify(interests)) return { action: "unchanged" };
  // The table keeps the watches' words in `keywords` (1 to 10) and their places in `locations` (up to 10); the
  // watches themselves decide the match.
  // NO LIMITS (owner, 2026-10-27; Telegram list #7, 2026-10-28): the column is a summary of the watches' words, and the
  // match reads each watch's own terms (prefs.interests). It used to refuse the whole save past 10 distinct terms, so an
  // 11th title term silently turned every watch's alerts off. The summary keeps the first 10; every watch keeps all of its own.
  const keywords = [...new Set(interests.flatMap((i) => i.keywords))].slice(0, 10);
  const v = validPrefs({ keywords, locations: [...new Set(interests.flatMap((i) => i.locations))].slice(0, 10) }, prev?.prefs ?? DEFAULT_PREFS);
  if (!v.ok) return { action: "refused", reason: v.error };
  const row = startWatching(prev, { userId: o.userId, prefs: { ...v.prefs, interests }, tz: prev?.tz ?? DEFAULT_TZ, now: o.now });
  await o.store.save(row);
  return { action: "saved" };
}

// At delivery (channel.ts deliverDue): whether a queued job alert (career_outbox key alert:<job_id>) or report
// (report:<day>) is still the person's to get, from their alert settings now, the watch record behind a row their
// watches made, and the posting. Settings gone or off, the watch record gone, paused or empty, or a posting that no
// longer fits (gone, closed, or a watch stopped since): not sent. Nothing that cannot be shown to fit is sent.
export const isAlertKey = (key: string) => /^(alert|report):/.test(String(key ?? ""));
export function alertStillWanted(key: string, now: { row: Pick<AlertRow, "prefs"> | null; record: unknown; posting?: unknown }): boolean {
  const prefs = prefsNow(now);
  if (!prefs) return false;
  if (String(key).startsWith("alert:")) return !!now.posting && matchPosting(now.posting, prefs);
  return isAlertKey(key);
}
// The person's alert settings as they are now, their watches the record's; null: nothing is wanted (off, gone, paused).
function prefsNow(now: { row: Pick<AlertRow, "prefs"> | null; record: unknown }): AlertPrefs | null {
  const row = now.row;
  if (!row || !row.prefs?.on) return null;
  let prefs = row.prefs;
  if (prefs.interests?.length) {
    const wp: any = now.record ?? null, interests = interestsFromWatch(wp);
    if (!interests.length || wp?.opt_out?.global) return null;
    prefs = { ...prefs, interests };
  }
  return prefs;
}

// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): the words of a queued job alert or daily report as they are true when it goes.
// An alert waits in the outbox (quiet hours, a delivery run behind) while its posting changes: its title ("Data Analyst"
// became "Senior Data Analyst"), its place, its company's name, its link; and its "first seen 3 min ago" grows old. A
// report waits while the person changes their search ("only remote now", another title): its lines were the old search's.
// So at delivery: an alert says its posting as it is now, with its age now; a report keeps the lines whose postings still
// fit the person's search (each said as it is now; a closed one is kept as written, for the delivery to say it closed),
// and says how many those are; nothing of the old search's is said. null: nothing of it is still true for the person (the
// posting gone, or no line of the report still theirs); it is not sent. `postings`: by job id (an alert) or by link (a
// report's lines). The settings and the watch record are read as alertStillWanted reads them.
export function freshAlertText(key: string, text: string, now: { row: Pick<AlertRow, "prefs"> | null; record: unknown; postings: Map<string, any>; at: number }): string | null {
  const prefs = prefsNow(now);
  if (!prefs) return null;
  if (String(key).startsWith("alert:")) {
    const p = now.postings.get(String(key).slice("alert:".length));
    return p && matchPosting(p, prefs) ? alertText(p, now.at) : null;
  }
  if (!String(key).startsWith("report:")) return text;
  const lines = String(text).split("\n");
  if (!/^Your daily job report: \d+ match(es)? in the last day/.test(lines[0] ?? "")) return text; // "no new matches": nothing to check
  const items: { line: string; url: string }[] = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const m = /^ {2}(https:\/\/\S+)$/.exec(lines[i] ?? "");
    if (!m || !lines[i - 1].startsWith("- ")) continue;
    const p = now.postings.get(m[1]);
    if (p && p.closed_at) { items.push({ line: lines[i - 1], url: m[1] }); continue; } // said closed at delivery
    if (p && matchPosting(p, prefs)) { items.push({ line: `- ${postingLine(p)}`, url: m[1] }); continue; }
    dropped++;
  }
  if (!items.length) return null;
  const more = lines.find((l) => /^…and \d+ more\. Ask me for the rest\.$/.test(l));
  // The count said is the lines kept when any were dropped (the ones not listed were the old search's, unseen here).
  const head = dropped
    ? `Your daily job report: ${items.length} match${items.length === 1 ? "" : "es"} in the last day that still fit${items.length === 1 ? "s" : ""} your search.`
    : lines[0];
  return [head, ...items.map((x) => `${x.line}\n  ${x.url}`), ...(more && !dropped ? [more] : [])].join("\n");
}
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a queued job alert against the person's fit floor and daily cap as they are
// now. An alert waits in the outbox (quiet hours, a delivery run behind) after it is planned; a person who raised their
// fit floor or asked for fewer alerts in that time still got everything planned under the old settings. `fit`: the fit
// the alert was queued with (null: not known, never held back on that account). `sentToday`: alerts already delivered to
// the person today on their own clock.
export function alertWithinLimits(prefs: Pick<AlertPrefs, "min_fit" | "max_instant_per_day"> | null | undefined, fit: number | null, sentToday: number): boolean {
  if (!prefs) return true; // no settings: alertStillWanted holds it
  if (typeof fit === "number" && typeof prefs.min_fit === "number" && fit < prefs.min_fit) return false;
  return sentToday < Math.min(MAX_INSTANT_PER_DAY, Math.floor(Number(prefs.max_instant_per_day) || 0));
}
