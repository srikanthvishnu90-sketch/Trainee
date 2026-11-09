// R10 WO-E, spec C.2 / E-79: the chat entry. A result in chat is ONE File card - never a dump of links - whose counts come from the
// roles' real states (results_spec.ts, one state per role, so they sum to the total; a target or an Apply tap is never counted),
// whose follow-up names the exact decision, and whose one button deep-links into the File at the role that decision is about.
// The card is plain words plus one button, so every chat channel (Telegram, WhatsApp, iMessage) can draw it.
import { type Ctx, timeIn } from "./file_family.ts";
import { vocab } from "./file_family_roles.ts";
import type { ResultRow } from "./results_page.ts";
import { stateCountsOf } from "./results_spec.ts";

export interface ChatCard { text: string; button: { label: string; url: string } }
export interface ChatCardInput {
  kicker: string; title: string; updatedAt: string | null; link: string; // link: the File's own private page
  rows: ResultRow[]; // the roles the File holds: the counts are theirs and nothing else's
  counts?: string[]; // counts the caller computed from the same real items (e.g. by listed pay); used instead of state counts
  decision?: { text: string; ref: string } | null; // the one decision the person owes, and the role it is about (the deep link)
  button?: string;
}
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const words = (s: string) => s.replace(URL_RE, "").replace(/\s{2,}/g, " ").trim(); // a link only ever travels as the button

export function chatFileCard(o: ChatCardInput, c: Ctx): ChatCard {
  const counts = o.counts ?? stateCountsOf(o.rows).filter((x) => x.n > 0).map((x) => `${x.n} ${vocab(x.key).count}`);
  const when = timeIn(o.updatedAt, c, { zone: true, cap: true });
  const fresh = [when ? `Updated ${when}` : "Update time unknown", ...counts].join(" - ");
  const ref = o.decision && o.rows.some((r) => r.ref === o.decision!.ref) ? o.decision.ref : null; // only a role this File holds
  const url = `${o.link}${ref ? `#r-${encodeURIComponent(ref)}` : ""}`;
  const lines = [words(o.kicker).toUpperCase(), words(o.title), fresh, o.decision ? words(o.decision.text) : null, "Opens your private File - nothing is submitted from chat."];
  return { text: lines.filter((x): x is string => !!x).join("\n"), button: { label: o.button ?? (ref ? "Review this role" : "Review roles"), url } };
}

// Several results are several cards, one each, in order - never one message holding many links.
export const chatFileCards = (xs: ChatCardInput[], c: Ctx): ChatCard[] => xs.map((x) => chatFileCard(x, c));
