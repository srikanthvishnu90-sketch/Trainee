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
// agent-chat passes heldEvents() below, so the events persist with the turn's commit or not at all (KNOWN GAPS,
// 2026-10-30: the stated facts' events below and the brain's confirm_profile_fact are held the same way).
import { type CareerEvent, type EventStore, recordEvent } from "./agent/timeline.ts";

// RESUME CONFIRM RACE (2026-10-30, migration 20261030060000): the confirmation's events are not written during the turn.
// They are held here and written by the turn's own commit (career_host_commit_evidenced), in the transaction that saves
// the profile holding the entries they evidence: a refused save (another thread saved first) writes none, so no record
// says "resume on file" while the profile still holds drafts, and the resend writes the only set. Nothing is read back.
export function heldEvents(): EventStore & { rows(): CareerEvent[] } {
  const rows: CareerEvent[] = [];
  return {
    async add(e) { rows.push(JSON.parse(JSON.stringify(e))); },
    async addMany(es) { for (const e of es) rows.push(JSON.parse(JSON.stringify(e))); },
    async recall() { return []; },
    rows: () => JSON.parse(JSON.stringify(rows)),
  };
}

export const RESUME_CONFIRM_PROVENANCE = "owner confirmed in chat the resume entry shown to them";
const CONFIRMING = new Set(["career_resume_ingest"]);

export interface Shown { text: string; message_ids: string[] }
export interface Upload { kind: "message" | "file"; ref: string; sha256: string; text: string; at?: string | null }
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

// ONBOARDING ROUND 3 (2026-11-01): the person corrects one value of a confirmed resume entry in chat ("actually I
// graduated 2023"; 142 handleResumeFieldCorrection). The entry's words changed, so the event that confirmed its old words
// no longer evidences it. It gets its own fact_confirmed event (this person, their message's hash, the value they gave
// and the one it replaced, the earlier event it supersedes) and an owner provenance, held for the turn's commit like the
// resume's. Only an entry this turn changed, still confirmed, whose new value is in the person's own message this turn;
// an entry that cannot be evidenced goes back to the words it had (nothing they did not confirm stands as confirmed).
export const ENTRY_CORRECTION_PROVENANCE = "owner corrected in chat the confirmed resume entry";
export const ENTRY_CORRECTION_VIA = "router: their correction of a confirmed resume entry";
// deno-lint-ignore no-explicit-any
export async function evidenceEntryCorrections(o: { userId: string; now: number; message: string; before: any; after: any; out: { intent?: string | null; resultStatus?: string | null } | null | undefined; events: EventStore | null | undefined }): Promise<{ stamped: number; reverted: number }> {
  const r = { stamped: 0, reverted: 0 };
  if (!o.out || o.out.intent !== "career_resume_correction" || o.out.resultStatus !== "completed") return r;
  // deno-lint-ignore no-explicit-any
  const had = new Map((Array.isArray(o.before?.facts) ? o.before.facts : []).filter((f: any) => f && f.id).map((f: any) => [f.id, f]));
  const said = words(o.message), at = new Date(o.now).toISOString(), message_sha256 = await sha256Hex(String(o.message ?? ""));
  for (const f of Array.isArray(o.after?.facts) ? o.after.facts : []) {
    // deno-lint-ignore no-explicit-any
    const was: any = f && had.get(f.id);
    if (!f || !was || words(was.text) === words(f.text) || f.status !== "confirmed" || f.needs_confirmation !== false || !f.owner_corrected_at) continue;
    const last = Array.isArray(f.corrections) && f.corrections.length ? f.corrections[f.corrections.length - 1] : null;
    const event = crypto.randomUUID();
    const kept = last && typeof last.to === "string" && words(last.to) && said.includes(words(last.to)) && was.status === "confirmed" && was.needs_confirmation === false
      ? await recordEvent(o.events, {
        user_id: o.userId, at: o.now, kind: "fact_confirmed", subject: String(f.text).slice(0, 300), source: "chat",
        detail: { id: f.id, kind: f.kind ?? null, confirmation_event_id: event, message_sha256, corrected: { from: String(last.from).slice(0, 120), to: String(last.to).slice(0, 120) },
          supersedes: was.confirmation_event_id ?? null, via: ENTRY_CORRECTION_VIA },
      })
      : false;
    if (!kept) {
      for (const k of Object.keys(f)) delete f[k];
      Object.assign(f, JSON.parse(JSON.stringify(was)));
      r.reverted++;
      continue;
    }
    Object.assign(f, { provenance: `${ENTRY_CORRECTION_PROVENANCE} (${at})`, confirmation_event_id: event, confirmed_at: at });
    r.stamped++;
  }
  return r;
}
export const correctionNotRecordedReply = "I couldn't record your correction just now, so your entry stays as you confirmed it before: nothing changed. Tell me again in a moment.";

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

// KNOWN GAPS (2026-10-30): the brain confirmed facts (confirm_profile_fact) but their events could not be written with the
// turn's save, so they are drafts again; the reply says so in place of the brain's "confirmed".
export function confirmNotRecordedReply(n: number): string {
  return `I couldn't record your confirmation just now, so ${n === 1 ? "that fact stays a draft" : `those ${n} facts stay drafts`}: nothing was confirmed, and a draft is never tailored, put on a form or sent. Say yes again in a moment.`;
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
export async function resumeConfirmationContext(rows: { id: string | number; role: string; content: string; created_at?: string | null }[], after: any): Promise<{ shown: Shown | null; upload: Upload | null; said: string }> {
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
    upload: { kind: "message", ref: `agent_messages:${m.id}`, sha256: await sha256Hex(String(m.content)), text: String(m.content), ...(m.created_at ? { at: String(m.created_at) } : {}) }, said: saidTexts.join("\n") };
}
