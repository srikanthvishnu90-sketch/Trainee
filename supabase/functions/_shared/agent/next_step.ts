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
// The line to add, or null: only when the turn's searches all came back empty, the kept reply neither asks nor offers, and the
// watch it offers is really saved for those words (`verified`, watchVerified below).
export function nextStepLine(reply: string, emptyQuery: string | null | undefined, anyFound: boolean, verified: (query: string) => boolean = () => false): string | null {
  if (!emptyQuery || anyFound || !String(reply ?? "").trim() || asksOrOffers(reply)) return null;
  return verified(emptyQuery) ? emptySearchNextStep(emptyQuery) : SEARCH_AGAIN;
}
// The one next step after an empty search, whatever else the reply holds (S3 r12f: D-101's floor reply uses it as its step (d)): the
// saved watch when code's watch really saves one for those words, else another search, wider.
export function emptyNextStep(emptyQuery: string, verified: (query: string) => boolean = () => false): string {
  return (verified(emptyQuery) ? emptySearchNextStep(emptyQuery) : null) ?? SEARCH_AGAIN;
}
// Ruling (S3 r12, after the review of cbea914e9): when the watch cannot be verified (no profile, a place in the words, a remapped
// title), the next step is one that is always true and needs nothing on file: another search, wider. No command is quoted, so no
// route has to match a phrase: whatever they reply is a new ask, and the brain searches it.
export const SEARCH_AGAIN = "Tell me a nearby job title or a wider area and I'll search again.";

// Review of ac1e068aa (REJECT): the line may promise a saved watch only when code's watch, run dry on the person's own state with the
// exact phrase the line quotes, saves one for exactly those words. Refused: no profile on file; a command word ("stop", "cancel my
// applications", "delete my account": a watch on "stop" is no watch); a figure (pay, a year: "data analyst $80k" saved "Data
// Analyst"); a phrase the staged route would not give to code's watch; a watch whose title is not the query's words ("remote
// software engineer jobs" saved "Software Engineering Intern / New-Grad"); a place in the words the watch did not keep ("…, New York"
// saved "… York — New York"; "… Columbus" saved "any location").
const COMMAND = /\b(?:stop|cancel|delete|remove|erase|forget|unsubscribe|pause|resume|quit|opt|apply|send|submit|undo|reset|block|report)\b/i;
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export interface WatchProbe { staged: (cmd: string) => { brain: boolean; intent: string | null }; run: (cmd: string) => { intent?: string | null; reply?: unknown } }
export function watchVerified(query: string, o: { hasProfile: boolean; probe: WatchProbe }): boolean {
  const w = watchWords(query);
  if (!w || !o.hasProfile || COMMAND.test(w) || /[\d$€£%]/.test(String(query))) return false;
  const cmd = watchCommand(w);
  const d = o.probe.staged(cmd);
  if (d.brain || d.intent !== "career_watch_create") return false;
  const r = o.probe.run(cmd);
  if (r.intent !== "career_watch_create") return false;
  const m = /^Watch set: (.+?)\.\s*\n\s*Watching: (.+?) \u2014 (.+?)(?: \+ remote)?\.\s/u.exec(String(r.reply ?? ""));
  if (!m || norm(m[1]) !== norm(w) || norm(m[2]) !== norm(w)) return false;
  // (a word written as a name after the first, "Columbus", "New York", is a place or an employer, and a watch that kept the query's
  // words as its title kept none of them as its place: refused; a lowercase place the watch read as one changed the title, refused above)
  return !w.split(/\s+/).slice(1).some((x) => /^\p{Lu}/u.test(x)) && !/[^,]\s*,|\bnear\b|\bin\s+\p{L}/iu.test(w);
}
