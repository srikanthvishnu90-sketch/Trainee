// FEATURE 1 (2026-10-25): apply from chat, on the live path (handler-career.ts handleChat, before the router).
// The chat's apply turn (career_apply_chat.ts applyTurn / applyManyTurn) puts postings into the person's own apply queue
// (career_apply_wanted, the store the brain's queue_applications writes). This module holds what that turn lacked on the
// live path (DIAGNOSIS 2026-10-25 2.1, fixes F1 and F2):
//   * positions: "apply to 1 and 3", "apply to #2", "apply to the 2nd one", "apply to the first and third", resolved
//     against the postings this thread last listed;
//   * the listed postings checked against the postings on file: a closed one, or one with no record and no link, is
//     refused by name ("posting not found"), never queued on the model's or the list's word alone;
//   * "no resume on file": with no confirmed resume entry stored for the person, nothing can be prepared, so nothing is
//     queued and the reply says what to do;
//   * the server-side prepare (workers/career-browser/prepare-ahead.ts) asked to run for exactly the rows queued, only
//     when the owner has configured the worker (CAREER_PREPARE_AHEAD_URL; off by default); the reply says which;
//   * the coverage line every apply reply starts with ("3/3 queued; ...");
//   * answer capture (F1): an answer the router's batch stack recorded in chat for a stopped application is also
//     recorded on the person's matching open question in career_apply_questions, the table the queue executor reads
//     (career_apply_answers_for), so the next prepare uses it.
// Nothing here approves, fills or sends anything: each application goes only on the person's tap of the card that shows
// it exactly.
import { checkAnswer, type OpenQuestion } from "./career_apply_questions.ts";
import { sameCompany } from "./career_mail.ts";
import { contentOf, type PostingContent } from "./career_apply_gate.ts";

// ------------------------------------------------------------------------------------------------ positions in the list
const ORD_WORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
};
// The positions a reply to a list names: "1 and 3", "1, 3 and 4", "#2", "number 2", "the 2nd one", "the first and third",
// "2nd and 4th ones". A bare single number ("3") is not a position (it may be a count); two or more numbers are.
// `after` is the text after "apply (me) (to|for)", lower case.
export function positionsOf(after: string): number[] | null {
  let t = String(after ?? "").toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) t = t.replace(/\s+(please|thanks|for me|ones?|postings?|jobs?|roles?|listings?|on the list|from the list)$/, "").trim();
  // "numbers 1 and 3" marks every token; "number 2" is kept for its token, which marks it.
  let marked = false;
  t = t.replace(/^the\s+/, "");
  if (/^(?:numbers|nos\.?)\s+/.test(t)) { marked = true; t = t.replace(/^(?:numbers|nos\.?)\s+/, ""); }
  if (!t) return null;
  const tokens = t.split(/\s*(?:,\s*(?:and\s+)?|\band\b|&|\+)\s*/).map((x) => x.trim()).filter(Boolean);
  if (!tokens.length || tokens.length > 20) return null;
  const out: number[] = [];
  for (const raw of tokens) {
    let x = raw.replace(/^the\s+/, "").replace(/\s+one$/, "");
    if (/^(#|number\s+|no\.\s*)/.test(x)) { marked = true; x = x.replace(/^(#\s*|number\s+|no\.\s*)/, ""); }
    let m = /^(\d{1,3})(st|nd|rd|th)?$/.exec(x);
    if (m) {
      if (m[2]) marked = true;
      out.push(Number(m[1]));
      continue;
    }
    if (x in ORD_WORD && x !== "last") { marked = true; out.push(ORD_WORD[x]); continue; }
    return null;
  }
  if (out.length === 1 && !marked) return null;
  if (out.some((n) => n < 1)) return null;
  return [...new Set(out)];
}

// ------------------------------------------------------------------------------------------ the listed postings on file
export interface Listed { job_id?: string; url?: string; company?: string; title?: string; location?: string; content?: PostingContent }
export interface ListedRefusal { job_id: string | null; company: string; title: string; reason: string }
// Each listed posting by its id on file (career_postings): closed is refused; no record and no link is "posting not
// found"; no record but a link is kept as listed (the extension can open it). A read that fails decides nothing: the
// posting is kept, and the screens and the database still apply.
export async function checkListed(picks: Listed[], get?: ((id: string) => Promise<any | null>) | null): Promise<{ ok: Listed[]; refused: ListedRefusal[] }> {
  if (!get) return { ok: picks, refused: [] };
  const ok: Listed[] = [], refused: ListedRefusal[] = [];
  for (const p of picks) {
    const id = String(p.job_id ?? "").trim();
    let rec: any = undefined;
    if (id) { try { rec = await get(id); } catch { rec = undefined; } }
    if (rec && rec.closed_at) {
      refused.push({ job_id: id || null, company: String(rec.company ?? p.company ?? ""), title: String(rec.title ?? p.title ?? ""), reason: "posting closed: it is no longer open on file" });
      continue;
    }
    if (rec) {
      ok.push({ job_id: String(rec.job_id ?? id), url: String(rec.url || p.url || ""), company: String(rec.company ?? p.company ?? ""), title: String(rec.title ?? p.title ?? ""), location: String(rec.location ?? p.location ?? ""), content: contentOf(rec) });
      continue;
    }
    if (rec === null && !String(p.url ?? "").trim()) {
      refused.push({ job_id: id || null, company: String(p.company ?? ""), title: String(p.title ?? ""), reason: "posting not found: it is not among the postings on file and I have no link for it" });
      continue;
    }
    ok.push(p);
  }
  return { ok, refused };
}

// ------------------------------------------------------------------------------------------------------ resume on file
// True when the profile the server prepares from (career_apply_profile_for: the person's most recent thread's profile)
// holds at least one resume entry the person confirmed with its recorded event (the trust contract's minimum); false when
// it holds none; null when it could not be read (unknown decides nothing).
// OWNER RULE (2026-10-26): the entries' events must be on record too (career_resume_on_file, 20261026210016: each
// confirmed entry's confirmation_event_id names a fact_confirmed event of this person). Only that function answers:
// when it errors, is missing or says anything but true/false, the answer is null (unknown), which every caller treats
// as "no resume" (fail closed). There is no weaker profile-only fallback (review of #194, 2026-10-27).
export function resumeOnFileReader(admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<any> }, userId: string): () => Promise<boolean | null> {
  return async () => {
    let r: any;
    try { r = await admin.rpc("career_resume_on_file", { p_user: userId }); } catch { return null; }
    if (r && !r.error && typeof r.data === "boolean") return r.data;
    return null;
  };
}
// deno-lint-ignore no-explicit-any
export function hasConfirmedResume(profile: any): boolean {
  const facts = profile && typeof profile === "object" && Array.isArray(profile.facts) ? profile.facts : [];
  // deno-lint-ignore no-explicit-any
  return facts.some((f: any) => f && f.status === "confirmed" && f.needs_confirmation === false && !!f.confirmation_event_id);
}
export const NO_RESUME_REASON = "no resume on file: I have no confirmed resume to prepare it from";
export const NO_RESUME_NEXT = "Paste or attach your resume, confirm it, then ask again.";
// OWNER RULE (2026-10-26, "never submit applications without a real resume"): with no confirmed resume nothing is queued,
// whether or not the server prepare is on (PR #175 queued the want when it was off; that is superseded). Kept for the
// wording of older replies only.
export const NO_RESUME_WAIT = "I have no confirmed resume on file yet, so nothing can be prepared until you paste or attach your resume and confirm it.";

// --------------------------------------------------------------------------------------------- the server-side prepare
export type PrepareKick = "started" | "off" | "failed";
// Asks the worker host's prepare-ahead service (prepare-ahead.ts serve) to prepare exactly these queued rows now. Only
// when the owner set CAREER_PREPARE_AHEAD_URL (and its CAREER_PREPARE_AHEAD_TOKEN); otherwise "off". The worker answers
// 202 when it has taken the run; anything else, or no answer in 4 seconds, is "failed". It never prepares here.
export async function kickPrepare(o: {
  env: { get(k: string): string | undefined }; fetch: typeof fetch; userId: string; jobIds: string[];
}): Promise<PrepareKick> {
  const url = (o.env.get("CAREER_PREPARE_AHEAD_URL") ?? "").trim(), token = (o.env.get("CAREER_PREPARE_AHEAD_TOKEN") ?? "").trim();
  if (!prepareConfigured(o.env) || !o.jobIds.length) return "off";
  try {
    const res = await o.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // Every id (NO LIMITS): the door splits a big request into parts; nothing is cut here.
      body: JSON.stringify({ user_id: o.userId, job_ids: o.jobIds }),
      signal: AbortSignal.timeout(4000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 202 || res.ok ? "started" : "failed";
  } catch {
    return "failed";
  }
}
// The owner configured the worker's prepare door (both its URL and its token): a row queued from chat is prepared at once.
export function prepareConfigured(env: { get(k: string): string | undefined }): boolean {
  return !!(env.get("CAREER_PREPARE_AHEAD_URL") ?? "").trim() && !!(env.get("CAREER_PREPARE_AHEAD_TOKEN") ?? "").trim();
}
export function prepareSentence(k: PrepareKick | null, n: number): string {
  if (k === null || n < 1) return "";
  const them = n === 1 ? "it" : "them";
  return k === "started"
    ? `I've started preparing ${them} now from your confirmed facts.`
    : `Preparing ${them} hasn't started yet; ${n === 1 ? "it waits" : "they wait"} in your queue.`;
}

// ------------------------------------------------------------------------------------------------------- the coverage
export function coverageLine(queued: number, total: number, already = 0): string {
  const base = `${queued}/${total} queued${already ? ` (${already} already in your queue)` : ""}`;
  return queued || already
    ? `${base}; I'll show you each application's exact answers on a card before anything is sent.`
    : `${base}.`;
}

// ----------------------------------------------------------------------------------- F1: chat answers to the executor
// What the router's batch stack recorded in chat this turn (142 SUBMIT-STEER-1130 answer capture): an entry with
// source "chat_answer" on the profile's answers (profile scope) or on an application's answers in the standing run
// (posting scope) that is new or changed since the turn began. The label is the form question's own words.
export interface ChatAnswer { key: string; label: string; value: string; company: string | null; scope: "profile" | "posting" }
// deno-lint-ignore no-explicit-any
const labelOf = (key: string, run: any, entry: any): string => {
  for (const app of Object.values((run && run.apps) || {}) as any[]) {
    for (const q of (app && app.stop && app.stop.questions) || []) if (q && q.question_key === key && q.label) return String(q.label);
  }
  const m = /answer to "([^"]{1,600})"/.exec(String(entry?.provenance ?? ""));
  return m ? m[1] : "";
};
// deno-lint-ignore no-explicit-any
export function chatAnswersRecorded(o: { before: any; after: any; runBefore: any; runAfter: any }): ChatAnswer[] {
  const out: ChatAnswer[] = [];
  // deno-lint-ignore no-explicit-any
  const fresh = (prev: any, a: any) => a && a.source === "chat_answer" && a.confirmed === true && a.value !== undefined && a.value !== null &&
    String(a.value).trim() !== "" && (!prev || String(prev.value) !== String(a.value));
  const pb = (o.before && o.before.answers) || {}, pa = (o.after && o.after.answers) || {};
  for (const [key, a] of Object.entries(pa) as [string, any][]) {
    if (!fresh(pb[key], a)) continue;
    const label = labelOf(key, o.runAfter, a) || labelOf(key, o.runBefore, a);
    if (label) out.push({ key, label, value: String(a.value).trim(), company: null, scope: "profile" });
  }
  const appsB = (o.runBefore && o.runBefore.apps) || {}, appsA = (o.runAfter && o.runAfter.apps) || {};
  for (const [pk, app] of Object.entries(appsA) as [string, any][]) {
    const prevAnswers = (appsB[pk] && appsB[pk].answers) || {};
    for (const [key, a] of Object.entries((app && app.answers) || {}) as [string, any][]) {
      if (!fresh(prevAnswers[key], a)) continue;
      const label = labelOf(key, o.runAfter, a) || labelOf(key, o.runBefore, a);
      const company = String(app?.company ?? app?.posting?.company ?? (o.runAfter?.postings?.[pk]?.company ?? "")) || null;
      if (label) out.push({ key, label, value: String(a.value).trim(), company, scope: "posting" });
    }
  }
  return out;
}

export interface QueueAnswerStore {
  open(userId: string): Promise<OpenQuestion[]>;
  answer(userId: string, id: string, text: string): Promise<void>;
}
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// Each recorded answer, on the person's open question with the same words: a profile-scope answer only on a shared
// question (fact: or label:), a posting-scope answer only on that employer's own (job:) question. The answer is checked
// against the question's own choices (checkAnswer, the questions turn's rule) and saved as that choice; one that does not
// fit is left open for the person to answer when asked. Returns what was recorded.
export async function recordChatAnswers(o: { userId: string; answers: ChatAnswer[]; store: QueueAnswerStore }): Promise<{ recorded: { label: string; company: string | null }[]; misfit: string[] }> {
  const recorded: { label: string; company: string | null }[] = [], misfit: string[] = [];
  if (!o.answers.length) return { recorded, misfit };
  const open = await o.store.open(o.userId);
  for (const a of o.answers) {
    const want = norm(a.label);
    const matches = open.filter((q) => norm(q.label) === want && (a.scope === "posting"
      ? q.key.startsWith("job:") && !!a.company && !!q.company && sameCompany(q.company, a.company)
      : !q.key.startsWith("job:")));
    for (const q of matches) {
      const c = checkAnswer(q, a.value);
      if (!c.ok) { misfit.push(q.label); continue; }
      await o.store.answer(o.userId, q.id, c.value);
      recorded.push({ label: q.label, company: q.company ?? null });
    }
  }
  return { recorded, misfit };
}
// deno-lint-ignore no-explicit-any
export function supabaseQueueAnswerStore(admin: any): QueueAnswerStore {
  return {
    async open(userId) {
      const { data, error } = await admin.rpc("career_apply_questions_open_as", { p_user: userId, p_limit: 20 });
      if (error) throw new Error(`read the open questions: ${error.message}`);
      return (data ?? []) as OpenQuestion[];
    },
    async answer(userId, id, text) {
      const { error } = await admin.rpc("career_apply_question_answer_as", { p_user: userId, p_id: id, p_answer: text });
      if (error) throw new Error(`record the answer: ${error.message}`);
    },
  };
}

// ------------------------------------------------------------------------------------------- the handler's one block
// What agent-chat (handler-career.ts, "FEATURE 1") wires: the apply turn's extra readers and the after-router answer
// capture. Service role, acting for the person whose chat this is.
export function feature1Deps(o: {
  // deno-lint-ignore no-explicit-any
  admin: any; userId: string; env: { get(k: string): string | undefined }; fetch: typeof fetch;
  posting: (id: string) => Promise<any | null>;
}) {
  return {
    apply: {
      posting: o.posting,
      resumeOnFile: resumeOnFileReader(o.admin, o.userId),
      prepare: (jobIds: string[]) => kickPrepare({ env: o.env, fetch: o.fetch, userId: o.userId, jobIds }),
      prepareOn: () => prepareConfigured(o.env),
    },
    // After the router's batch turn: an answer it recorded in chat is recorded on the matching open queue question too.
    // deno-lint-ignore no-explicit-any
    async afterRouter(a: { reply: string; before: any; after: any; runBefore: any; runAfter: any }): Promise<{ reply: string; recorded: number }> {
      const answers = chatAnswersRecorded({ before: a.before, after: a.after, runBefore: a.runBefore, runAfter: a.runAfter });
      if (!answers.length) return { reply: a.reply, recorded: 0 };
      try {
        const r = await recordChatAnswers({ userId: o.userId, answers, store: supabaseQueueAnswerStore(o.admin) });
        if (!r.recorded.length) return { reply: a.reply, recorded: 0 };
        const n = r.recorded.length;
        return { reply: `${a.reply}\nI also recorded it on ${n === 1 ? "the question" : `${n} questions`} waiting in your apply queue (${[...new Set(r.recorded.map((x) => x.label))].join("; ")}), so the next preparation uses it.`, recorded: n };
      } catch (e) {
        console.error("feature 1 answer capture:", (e as Error)?.message ?? e);
        return { reply: `${a.reply}\nI couldn't record it for the applications waiting in your apply queue just now; I'll ask it there when one needs it.`, recorded: 0 };
      }
    },
  };
}
