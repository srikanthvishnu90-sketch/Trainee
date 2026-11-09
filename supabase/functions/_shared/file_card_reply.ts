// R10 spec C.2 (D-049): a turn that made a File answers with ONE File card instead of the link alone (behind CAREER_FILE_CARD).
//   telegram            the sentences, then the card's words as one message whose only link is its inline URL button
//                       (the channel sends `card` with that button; the URL is not in the text)
//   whatsapp, imessage, sms, web
//                       the sentences, then the card's words with the plain link as its last line
// The card's words come from file_family_card.ts chatFileCard: kicker, title, freshness with real counts, the boundary. Nothing
// else of the reply changes; with the switch off the reply is exactly what it was.
import type { Ctx } from "./file_family.ts";
import { chatFileCard } from "./file_family_card.ts";

export const FILE_CARD_ENV = "CAREER_FILE_CARD";
export const fileCardOn = (env: { get(k: string): string | undefined }): boolean => (env.get(FILE_CARD_ENV) ?? "").trim().toLowerCase() === "on";

export interface FileCardSource { kicker: string; title: string; url: string; updatedAt: string | null; counts: string[]; decision?: string | null; button?: string }
export interface FileCardOut { text: string; label: string; url: string }

export function withFileCard(o: { channel: string; reply: string; parts?: string[] | null; src: FileCardSource }, c: Ctx): { reply: string; parts: string[]; card: FileCardOut | null } {
  const base = (o.parts?.length ? o.parts : o.reply.split("\n")).map((x) => x.trim()).filter((x) => x && x !== o.src.url);
  const made = chatFileCard({ kicker: o.src.kicker, title: o.src.title, updatedAt: o.src.updatedAt, link: o.src.url, rows: [], counts: o.src.counts,
    decision: o.src.decision ? { text: o.src.decision, ref: "" } : null, button: o.src.button ?? "Open the File" }, c);
  if (o.channel === "telegram") return { reply: [...base, made.text].join("\n"), parts: base, card: { text: made.text, label: made.button.label, url: o.src.url } };
  const last = `${made.text}\n${o.src.url}`;
  return { reply: [...base, last].join("\n"), parts: [...base, last], card: null };
}
