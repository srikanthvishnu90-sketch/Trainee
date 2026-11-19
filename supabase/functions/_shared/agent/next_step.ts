// S3 r12 (architect ruling, 2026-11-18): after an empty job search, a reply whose kept text (what the reply pipeline let stand)
// asks the person nothing and offers nothing leaves them with no next step (dev H035: "The search for ... returned 0 postings.
// Nothing has been sent or applied to."). Code then adds ONE line in its own words, built only from the search's own words, that
// offers what an existing route really does: "watch for <words> roles" is code's watch (router career_watch_create), which saves a
// watch on their list. Alert delivery is not on in this release, so the line promises a saved watch, never a text when one opens.
// It is a code line: added after the pipeline and the condense pass, never judged.

// The words a watch can key on: the search's own query, as the person's search asked it (no quotes, no punctuation that would
// change how the router reads the command).
export function watchWords(query: string): string | null {
  const w = String(query ?? "").replace(/["“”'‘’`]/g, "").replace(/[^\p{L}\p{N}\s&+/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return w.split(/\s+/).filter(Boolean).length ? w : null;
}
// The command the line quotes, exactly as the person would send it.
export const watchCommand = (words: string) => `watch for ${words} roles`;
export function emptySearchNextStep(query: string): string | null {
  const w = watchWords(query);
  return w ? `Say "${watchCommand(w)}" and I'll save a watch for them on your list.` : null;
}
// A question to the person, or an offer of what Trainee can do next, anywhere in the kept reply.
const OFFER = /\?|\b(?:want me to|would you like me to|shall i|should i|i can|i could|i'll|i will|you can (?:ask|say|text|tell|send|name|reply)|say ["“]|reply ["“]|text ["“]|tell me)\b/i;
export const asksOrOffers = (reply: string) => OFFER.test(String(reply ?? ""));
// The line to add, or null: only when the turn's searches all came back empty and the kept reply neither asks nor offers.
export function nextStepLine(reply: string, emptyQuery: string | null | undefined, anyFound: boolean): string | null {
  if (!emptyQuery || anyFound || !String(reply ?? "").trim() || asksOrOffers(reply)) return null;
  return emptySearchNextStep(emptyQuery);
}
