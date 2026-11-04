// SUBMIT-STEER-1130 / SPLIT-1146 (a): the writer for a resume confirmation, with real provenance.
//
// The router (142) confirms a pasted resume when the person says it is theirs ("yes, that's my resume"): every entry goes
// from draft to confirmed, with no provenance and no confirmation event, so the trust contract every application reads
// (trustedProfile, trustedManifest: WO-102) keeps none of them. This stamps the evidence the contract asks for, but only
// for what the person actually confirmed:
//   - a fact the turn confirmed (a draft in the profile the turn started from, confirmed in the one it left), on the
//     router's own confirm of a pasted resume (intent career_resume_ingest, completed);
//   - whose words Trainee showed the person, verbatim, between their upload and their yes (`shown`): a yes to "I read it
//     as 15 facts" confirms no fact's words, so it evidences none;
//   - whose words are in the person's own upload (`upload`: their message, or their file, by reference and hash): a fact
//     minted from a document or a model's claim, not traceable to what they gave, is never evidenced.
// Each stamped fact names a persisted fact_confirmed event (this person, now, their own message's hash, the upload's
// reference and hash, the hash of what was shown) and carries an owner provenance. An event that cannot be recorded stamps
// nothing: the fact reads as needs-review, never as evidenced (the brain's rule, career_tools.ts confirm_profile_fact).
import { type EventStore, recordEvent } from "./agent/timeline.ts";

export const RESUME_CONFIRM_PROVENANCE = "owner confirmed in chat the resume entry shown to them";
const CONFIRMING = new Set(["career_resume_ingest"]);

export interface Shown { text: string; message_ids: string[] }
export interface Upload { kind: "message" | "file"; ref: string; sha256: string; text: string }
// held: the facts the router confirmed that could not be evidenced, put back to drafts (the host's record is the truth: a
// fact no application may use is not called confirmed).
export interface EvidenceResult { stamped: number; unshown: number; untraced: number; refused: number; held: string[] }

export async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Words compared as words: case, spacing, line breaks and dash or quote styles never decide.
export const words = (s: unknown) => String(s ?? "").toLowerCase().replace(/[‐-―−]/g, "-").replace(/[‘’`]/g, "'").replace(/[“”]/g, '"')
  .replace(/[•·▪●◦*]/g, " ").replace(/\s+/g, " ").trim();

// A corrected entry's corrections ({ from, to }, in the order made), compared as words.
// deno-lint-ignore no-explicit-any
const correctionsOf = (f: any): { from: string; to: string }[] => (Array.isArray(f?.corrections) ? f.corrections : [])
  // deno-lint-ignore no-explicit-any
  .filter((c: any) => c && typeof c.from === "string" && typeof c.to === "string" && words(c.from) && words(c.to)).map((c: any) => ({ from: words(c.from), to: words(c.to) }));
const undo = (p: string, fixes: { from: string; to: string }[]) => fixes.slice().reverse().reduce((x, c) => x.split(c.to).join(c.from), p);

// deno-lint-ignore no-explicit-any
export async function evidenceResumeConfirmation(o: {
  userId: string; now: number; message: string; before: any; after: any;
  out: { intent?: string | null; resultStatus?: string | null } | null | undefined;
  shown: Shown | null | undefined; upload: Upload | null | undefined; events: EventStore | null | undefined;
  // The person's own messages after the upload (their corrections), from resumeConfirmationContext.
  said?: string | null;
}): Promise<EvidenceResult> {
  const r: EvidenceResult = { stamped: 0, unshown: 0, untraced: 0, refused: 0, held: [] };
  if (!o.out || !CONFIRMING.has(String(o.out.intent)) || o.out.resultStatus !== "completed") return r;
  const facts = Array.isArray(o.after?.facts) ? o.after.facts : [];
  // deno-lint-ignore no-explicit-any
  const drafts = new Set((Array.isArray(o.before?.facts) ? o.before.facts : []).filter((f: any) => f && f.needs_confirmation === true).map((f: any) => f.id));
  // deno-lint-ignore no-explicit-any
  const turned = facts.filter((f: any) => f && drafts.has(f.id) && f.status === "confirmed" && f.needs_confirmation === false &&
    !f.confirmation_event_id && !f.provenance && words(f.text));
  if (!turned.length) return r;
  const shown = words(o.shown?.text), given = words(o.upload?.text), said = words(o.said);
  const at = new Date(o.now).toISOString(), message_sha256 = await sha256Hex(String(o.message ?? ""));
  const shown_sha256 = o.shown ? await sha256Hex(o.shown.text) : null;
  // deno-lint-ignore no-explicit-any
  const hold = (f: any) => { Object.assign(f, { status: "draft", needs_confirmation: true }); r.held.push(f.id); };
  for (const f of turned) {
    const w = words(f.text);
    if (!shown || !shown.includes(w)) { r.unshown++; hold(f); continue; }
    // The entry's own lines are in what they gave; the words that join them (title, then bullets) need not be.
    const parts = [f.title, ...(Array.isArray(f.bullets) ? f.bullets : []), ...(f.title || f.bullets ? [] : [f.text])].map(words).filter(Boolean);
    // ONBOARDING SCENARIOS (2026-10-29): an entry the person corrected before their yes ("my title was X, not Y") is
    // traced as their words too: each line, with their corrections undone, is in their upload, and each corrected value
    // is in a message of theirs after it (`said`). Anything else in it is still untraced.
    const fixes = correctionsOf(f);
    const traced = (p: string) => given.includes(p) || (fixes.length > 0 && given.includes(undo(p, fixes)) && fixes.every((c) => said.includes(c.to)));
    if (!o.upload || !given || !parts.length || !parts.every(traced)) { r.untraced++; hold(f); continue; }
    const event = crypto.randomUUID();
    const kept = await recordEvent(o.events, {
      user_id: o.userId, at: o.now, kind: "fact_confirmed", subject: f.text, source: "chat",
      detail: { id: f.id, kind: f.kind ?? null, confirmation_event_id: event, message_sha256, shown_sha256, shown_message_ids: o.shown!.message_ids.slice(0, 10),
        upload: { kind: o.upload.kind, ref: o.upload.ref, sha256: o.upload.sha256 }, via: "router: their yes to the resume entries shown to them" },
    });
    if (!kept) { r.refused++; hold(f); continue; }
    Object.assign(f, {
      provenance: `${RESUME_CONFIRM_PROVENANCE} (${at})`, confirmation_event_id: event, confirmed_at: at,
      source_ref: { upload: o.upload.ref, upload_sha256: o.upload.sha256, shown_sha256 },
    });
    r.stamped++;
  }
  return r;
}

// The reply when some or all of the facts the router confirmed could not be evidenced and were held as drafts: what is
// confirmed and what is not, and why, in place of the router's "confirmed" (null when nothing was held).
export function heldReply(r: EvidenceResult): string | null {
  if (!r.held.length) return null;
  const why = [
    r.unshown ? `${r.unshown} ${r.unshown === 1 ? "was" : "were"} not shown to you word for word` : "",
    r.untraced ? `${r.untraced} ${r.untraced === 1 ? "is" : "are"} not in the resume you gave me` : "",
    r.refused ? `${r.refused} could not be recorded just now` : "",
  ].filter(Boolean).join(", ");
  const head = r.stamped
    ? `${r.stamped} of your resume entries are confirmed, each as you saw it. ${r.held.length} stay drafts: ${why}.`
    : `Nothing from your resume is confirmed yet: I confirm an entry only when you have seen its words and said yes to them, and ${why}.`;
  return `${head} A draft is never tailored, put on a form or sent.`;
}

// FEATURE 9: a fact the person states in chat ("I'm a junior", "I need sponsorship", "my recruiter at Acme is Dana") is
// captured by the router into the account's stated facts with no event behind it. This gives each such fact the same
// provenance a confirmed resume entry gets, under the same rule: only what this turn added (absent from the record the
// turn started from, or a new value under the same identity), only when its words are in the person's own message this
// turn, and only once the event is recorded. A fact whose event cannot be recorded stays as it was: a statement on the
// record, never called confirmed.
export const STATED_FACT_PROVENANCE = "owner stated in chat, in their own words";
export interface StatedEvidence { stamped: number; untraced: number; refused: number }
// deno-lint-ignore no-explicit-any
const statedIdOf = (f: any) => f && typeof f.key === "string" && f.key ? `key:${f.kind}:${f.key.toLowerCase()}` : `${f?.kind}:${words(f?.value)}`;
export async function evidenceStatedFacts(o: {
  // deno-lint-ignore no-explicit-any
  userId: string; threadId: string; now: number; message: string; before: any[] | null | undefined; after: any[] | null | undefined;
  events: EventStore | null | undefined;
}): Promise<StatedEvidence> {
  const r: StatedEvidence = { stamped: 0, untraced: 0, refused: 0 };
  // deno-lint-ignore no-explicit-any
  const had = new Map((Array.isArray(o.before) ? o.before : []).filter(Boolean).map((f: any) => [statedIdOf(f), words(f.value)]));
  // deno-lint-ignore no-explicit-any
  const fresh = (Array.isArray(o.after) ? o.after : []).filter((f: any) => f && typeof f === "object" && f.kind && words(f.value) &&
    !f.confirmation_event_id && (!had.has(statedIdOf(f)) || had.get(statedIdOf(f)) !== words(f.value)));
  if (!fresh.length) return r;
  const said = words(o.message), at = new Date(o.now).toISOString(), message_sha256 = await sha256Hex(String(o.message ?? ""));
  for (const f of fresh) {
    // Their words: the fact's own evidence quote, else its value, must be in what they wrote this turn.
    const quote = words(f.evidence) && said.includes(words(f.evidence)) ? words(f.evidence) : (said.includes(words(f.value)) ? words(f.value) : "");
    if (!quote) { r.untraced++; continue; }
    const event = crypto.randomUUID();
    const kept = await recordEvent(o.events, {
      user_id: o.userId, at: o.now, kind: "fact_confirmed", subject: `${f.kind}: ${String(f.value)}`.slice(0, 300), source: "chat",
      detail: { kind: f.kind, ...(f.key ? { key: f.key } : {}), value: String(f.value).slice(0, 200), confirmation_event_id: event, message_sha256,
        thread_id: o.threadId, via: "router: stated by the person in chat" },
    });
    if (!kept) { r.refused++; continue; }
    Object.assign(f, { provenance: `${STATED_FACT_PROVENANCE} (${at})`, confirmation_event_id: event, confirmed_at: at });
    r.stamped++;
  }
  return r;
}

// What the person was shown and what they gave, from their thread's messages (newest first, as read): the assistant's
// replies since their latest message that carries the confirmed entries' words, and that message, as their upload.
// deno-lint-ignore no-explicit-any
export async function resumeConfirmationContext(rows: { id: string | number; role: string; content: string }[], after: any): Promise<{ shown: Shown | null; upload: Upload | null; said: string }> {
  // A corrected entry's lines are looked for as they were given (its corrections undone).
  // deno-lint-ignore no-explicit-any
  const lines: string[] = (Array.isArray(after?.facts) ? after.facts : []).flatMap((f: any) => [f?.title, ...(Array.isArray(f?.bullets) ? f.bullets : [])].map(words).filter(Boolean).map((l: string) => undo(l, correctionsOf(f))));
  const shownTexts: string[] = [], ids: string[] = [], saidTexts: string[] = [];
  // rows[0] is the person's yes this turn when the host stored it already; it is never the upload.
  // ONBOARDING SCENARIOS (2026-10-29): the upload is the message that carries the MOST of the entries' lines, each as
  // whole words. It was the newest message holding any line as a substring, so with a one-letter or two-letter skill
  // ("R", "Go") on the resume any later message ("where did I go to school?", a correction) was taken for the upload,
  // and every entry was then held as "not in the resume you gave me".
  const holds = (w: string, l: string) => ` ${w.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${l.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `);
  let best = -1, bestScore = 0;
  rows.forEach((m, i) => {
    if (m.role !== "user" || !lines.length) return;
    const w = words(m.content);
    const score = lines.filter((l) => holds(w, l)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  if (best < 0) return { shown: null, upload: null, said: "" };
  for (const m of rows.slice(0, best)) {
    if (m.role === "assistant") { shownTexts.unshift(String(m.content ?? "")); ids.unshift(String(m.id)); }
    else if (m.role === "user") saidTexts.unshift(String(m.content ?? ""));
  }
  const m = rows[best];
  return { shown: shownTexts.length ? { text: shownTexts.join("\n"), message_ids: ids } : null,
    upload: { kind: "message", ref: `agent_messages:${m.id}`, sha256: await sha256Hex(String(m.content)), text: String(m.content) }, said: saidTexts.join("\n") };
}
