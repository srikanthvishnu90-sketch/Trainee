// WO-032: applying by email, for a posting whose application is "email your resume to X" (career_postings.apply_email,
// found in ingestion by apply_email.ts). One turn, before any brain, like the card and the questions:
//   "apply by email to Acme" (or "apply to Acme by email", optionally "for <title>") prepares the email card: the address
//   the posting gives, a subject from the posting's title, a body drafted ONLY from the person's confirmed facts through
//   WO-030's drafting and fact-lock (essay_draft.ts: the employer's AI policy first, every name and number traced to a
//   confirmed fact or the posting, the length met by rewriting, never by cutting), and the resume attached: the one
//   WO-028 tailors to this posting from confirmed facts (career_tailor.ts).
//   The whole email is shown; nothing is sent.
//   "yes", while that card is the thread's last word, sends exactly that payload, once, from the person's own Gmail
//   (users.messages.send through the career grant): one recipient, no Cc, no Bcc. The database takes the yes only for the
//   payload hash on the card, within a day, under the daily limit, one per posting and one per company per 30 days
//   (career_apply_email_reserve_as), and the send is recorded on a tracked application (source 'email').
//   "subject: ..." or "body: ..." changes the email and shows it again; the change needs its own yes. "no" drops it.
// The owner's switch (CAREER_EMAIL_SEND=on) off: the yes is told so, nothing is reserved or sent, the card is kept (WO-091c).
// No career grant that may send: NOT_WIRED, with the one thing to do, and nothing is reserved. No resume Trainee can
// attach: NOT_WIRED the same way. The model writes sentences only; code decides everything that matters.
import { type DraftDeps, draftEssay, MIN_FACTS, whatWouldHelp } from "./essay_draft.ts";
import { hashApplyPayload } from "./career_apply_store.ts";
import { onEmployerDomain, roleOverlap, sameCompany } from "./career_mail.ts";
import { ONE_ADDRESS, type OutMail, type SendResult } from "./career_mail_gmail.ts";
import { RESUME_BUCKET, resumePath, type TailorDeps, tailorForPosting } from "./career_tailor.ts";

export const EMAIL_INTENT = "career_apply_email";
export const EMAIL_CARD_KEY = "career:email-card";
export const BODY_WORDS = 150;
const DAY = 86400000;

export interface EmailPosting { job_id: string; company: string; title: string; url: string; description?: string | null; apply_email: string | null }
export interface Resume { filename: string; bytes: Uint8Array; sha256: string; tailored: boolean; mime?: string }
export interface EmailPayload {
  kind: "email"; version: 1; user_id: string; job_id: string; company: string; title: string; url: string;
  to: string; subject: string; body: string;
  attachment: { filename: string; sha256: string; size: number; tailored: boolean };
  resume_sha256: string; resume_tailored: boolean; // WO-028's tag on the tracked application reads these
}
// Each card shown has its own id; the turn that shows it writes that id into the thread's last word (meta.email_card),
// and a yes counts only for the card that last word names. A change, or a card shown again, is a new id.
export interface EmailCard { id: string; payload: EmailPayload; payload_hash: string; state: "shown" | "sending" | "sent" | "failed" | "declined"; shown_at: string; thread: string; application?: string }
export interface EmailTurn { reply: string; status: string; waiting: boolean; card_id?: string }
export interface Profile { facts?: unknown[]; basics?: { name?: string | null } | null }
export interface EmailStore {
  postings(company: string): Promise<EmailPosting[]>; // open postings that take an emailed application, at that company
  card(userId: string): Promise<EmailCard | null>;
  setCard(userId: string, c: EmailCard): Promise<void>;
  lastAssistant(threadId: string): Promise<{ intent: string | null; meta: Record<string, unknown> } | null>;
  // career_apply_email_reserve_as: throws changed_since_yes, duplicate_job, company_cooldown or daily_cap.
  reserve(userId: string, payload: EmailPayload, hash: string): Promise<{ id: string; lease_token: string }>;
  finish(userId: string, id: string, lease: string, state: "submitted_unconfirmed" | "not_submitted" | "unknown_outcome", evidence: Record<string, unknown>): Promise<void>;
}
export interface EmailDeps {
  store: EmailStore;
  profile: () => Profile;
  draft?: DraftDeps;
  resume: (userId: string, posting: EmailPosting) => Promise<Resume | null>; // tailored to the posting, else their file
  attachment: (userId: string, sha256: string) => Promise<Resume | null>; // the exact file on the card, by its hash
  canSend: (userId: string) => Promise<boolean>; // a career grant with gmail.send
  send: (userId: string, m: OutMail) => Promise<SendResult>;
  // WO-091c: the owner's switch. The chat passes CAREER_EMAIL_SEND === "on" (agent-chat/handler-career.ts), the same
  // pattern as outreach's CAREER_OUTREACH_SEND; false: a yes sends nothing and reserves nothing, and the card is kept.
  // Absent only where a test drives the turn directly.
  sendOn?: boolean;
  // OWNER RULE (2026-10-26, "never submit applications without a real resume"): the same check as the chat's apply turn
  // and the card (resumeOnFileReader: career_resume_on_file). true: on file; false: none; null: could not be read, which
  // decides nothing, so nothing is prepared or sent (fail closed). Read before an email is drafted and again before the
  // yes reserves it. The database refuses the reserve on its own too (career_apply_jobs_resume_guard, 20261026210016).
  resumeOnFile?: () => Promise<boolean | null>;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// What the canonical hash and the database agree on: no control characters but the line break.
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

// ------------------------------------------------------------------------------------------------ what the person says
export type EmailReply =
  | { kind: "apply"; company: string; title: string | null }
  | { kind: "yes" } | { kind: "no" }
  | { kind: "subject"; value: string } | { kind: "body"; value: string };
const APPLY = [
  /^(?:please |can you |could you )?(?:apply|send (?:my|an|the) application|email (?:my|an|the) application)(?: to| at)? (.{2,80}?) (?:by|via|over|through) e-?mail(?: for (?:the )?(.{2,80}?)(?: role| position| job)?)?$/,
  /^(?:please |can you |could you )?(?:apply by e-?mail|e-?mail (?:my )?(?:application|resume|cv)) (?:to|at) (.{2,80}?)(?: for (?:the )?(.{2,80}?)(?: role| position| job)?)?$/,
];
export function parseEmailReply(text: string): EmailReply | null {
  const raw = String(text ?? "").trim();
  const edit = /^(subject|body)\s*:\s*([\s\S]+)$/i.exec(raw);
  if (edit) return { kind: edit[1].toLowerCase() as "subject" | "body", value: edit[2].trim() };
  const t = raw.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  for (const re of APPLY) {
    const m = re.exec(t);
    if (m) return { kind: "apply", company: m[1].trim(), title: m[2]?.trim() || null };
  }
  if (/^(yes|yep|yeah|y|send it|yes send it|yes please|send)$/.test(t)) return { kind: "yes" };
  if (/^(no|nope|n|don'?t send( it)?|drop it|cancel it)$/.test(t)) return { kind: "no" };
  return null;
}

// ------------------------------------------------------------------------------------------------ preparing
export function bodyQuestion(p: EmailPosting): string {
  return `Write the body of a short email applying for the ${clip(p.title, 120)} role at ${clip(p.company, 120)}: who you are and why you fit, in ${BODY_WORDS} words or less.`;
}
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type Prepared = { ok: true; payload: EmailPayload; hash: string } | { ok: false; status: string; reply: string };
export async function prepareEmail(o: { userId: string; posting: EmailPosting; profile: Profile; resume: Resume | null; draft?: DraftDeps }): Promise<Prepared> {
  const p = o.posting, co = clip(p.company, 120);
  const to = String(p.apply_email ?? "").trim().toLowerCase();
  if (!ONE_ADDRESS.test(to)) return { ok: false, status: "no_address", reply: `${co}'s posting doesn't give one address to email, so I can't apply by email there.` };
  const name = clip(o.profile.basics?.name, 120);
  if (!name) return { ok: false, status: "no_name", reply: `I need your name to sign the email. Tell me your full name, then say "apply by email to ${co}" again.` };
  if (!o.resume) {
    return { ok: false, status: "NOT_WIRED", reply: `NOT_WIRED: Trainee couldn't make a resume to attach from your confirmed facts. Confirm your name, email and at least one job, project or school with me, then say "apply by email to ${co}" again.` };
  }
  if ((await sha(o.resume.bytes)) !== o.resume.sha256) return { ok: false, status: "resume_changed", reply: "Your resume file doesn't match its record, so I won't attach it. Add it again, then ask me again." };
  if (!o.draft) return { ok: false, status: "draft_off", reply: `I can't draft the email here. Write it yourself and send it to ${to}.` };
  // The posting's own words carry its AI policy (a "no AI-written applications" posting is never drafted for).
  const q = { id: `email:${p.job_id}`, label: bodyQuestion(p), type: "textarea", kind: "essay", company: p.company, job_ids: [p.job_id], ai_policy: null };
  const siblings = String(p.description ?? "").split(/(?<=[.!?])\s+/).filter((s) => /\b(ai|artificial intelligence|chatgpt|generative|llm)\b/i.test(s)).slice(0, 10);
  const d = await draftEssay({ q, siblingLabels: siblings, deps: o.draft })
    .catch((e) => ({ ok: false as const, why: "model" as const, policy: null, detail: [String(e?.message ?? e)], tries: 0 }));
  if (!d.ok) {
    const own = `You can also write it yourself and send it to ${to}.`;
    const reply = d.why === "policy"
      ? `${co}'s posting asks for applications in your own words${d.policy?.said ? ` ("${clip(d.policy.said, 90)}")` : ""}, so I won't draft this email. ${own}`
      : d.why === "thin"
      ? `I can't draft the email yet: only ${d.detail[0]} of your confirmed facts fit it, and I need at least ${MIN_FACTS} so nothing is made up. Tell me ${whatWouldHelp(q.label, p.company)}, confirm it, then say "apply by email to ${co}" again. ${own}`
      : d.why === "unverified"
      ? `I didn't show a draft: it kept including things you haven't confirmed (${d.detail.join("; ")}). If any of that is true, tell me and confirm it, then ask again. ${own}`
      : d.why === "too_long"
      ? `I couldn't write it inside ${BODY_WORDS} words without cutting a sentence, so there's no draft. ${own}`
      : `I couldn't draft the email right now, so nothing changed. Try again in a few minutes. ${own}`;
    return { ok: false, status: `draft_${d.why}`, reply };
  }
  const payload: EmailPayload = {
    kind: "email", version: 1, user_id: o.userId, job_id: p.job_id, company: clean(p.company, 200), title: clean(p.title, 200), url: p.url,
    to, subject: clean(`Application: ${clip(p.title, 150)}`, 200),
    body: clean(`Hello ${co} hiring team,\n\n${d.text}\n\nMy resume is attached.\n\n${name}`, 5000),
    attachment: { filename: clip(o.resume.filename, 120) || "resume.pdf", sha256: o.resume.sha256, size: o.resume.bytes.length, tailored: !!o.resume.tailored },
    resume_sha256: o.resume.sha256, resume_tailored: !!o.resume.tailored,
  };
  return { ok: true, payload, hash: await hashApplyPayload(payload) };
}

// The whole email, as it will go. Plain text; nothing on the card that the email does not carry.
export function emailCardText(p: EmailPayload, changed = false): string {
  return [
    changed
      ? `Changed. Here is the whole email again; nothing is sent until you say yes to this version.`
      : `${clip(p.company, 80)}'s posting asks for applications by email. Here is the whole email; nothing is sent until you say yes.`,
    `To: ${p.to}`,
    // The same rules as a confirming sender (career_mail.ts): the posting's own site, else the exact name on .com.
    ...(onEmployerDomain(p.to, p.company, p.url) ? [] : [`This address is not on ${clip(p.company, 80)}'s domain; check it against the posting.`]),
    `Subject: ${p.subject}`,
    `Attached: ${p.attachment.filename}${p.attachment.tailored ? " (tailored for this job)" : ""}`,
    "",
    p.body,
    "",
    `Reply "yes" to send it from your Gmail, "no" to drop it, or "subject: ..." or "body: ..." to change it.`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ the turn
const REFUSED: Record<string, string> = {
  daily_cap: "today's daily application limit is already used",
  company_cooldown: "you applied to them in the last 30 days",
  duplicate_job: "this posting is already in your applications (sent, or approved and waiting to go), and each posting goes at most once",
  changed_since_yes: "the email changed after you saw it, so your yes was not for this version",
  no_resume: "I have no confirmed resume on file for you, so nothing goes without one",
};
const RESUME_UNREAD_EMAIL = "I couldn't check your resume on file just now, so nothing was drafted or sent. Ask again in a minute.";
const NO_RESUME_EMAIL = "Not drafted: I have no confirmed resume on file for you, and no application goes without one. Paste or attach your resume, confirm it, then ask again.";
async function resumeState(o: { resumeOnFile?: () => Promise<boolean | null> }): Promise<"on_file" | "missing" | "unknown"> {
  if (!o.resumeOnFile) return "on_file"; // only where a test drives the turn without the check; the chat always passes it
  let r: boolean | null;
  try { r = await o.resumeOnFile(); } catch { r = null; }
  return r === true ? "on_file" : r === false ? "missing" : "unknown";
}
export async function emailTurn(o: { message: string; userId: string; threadId: string; now: number; deps: EmailDeps }): Promise<EmailTurn | null> {
  const r = parseEmailReply(o.message);
  if (!r) return null;
  const s = o.deps.store;
  const at = new Date(o.now).toISOString();
  const show = async (card: Omit<EmailCard, "id" | "state" | "shown_at" | "thread">, lead: string | null): Promise<EmailTurn> => {
    const c: EmailCard = { ...card, id: crypto.randomUUID(), state: "shown", shown_at: at, thread: o.threadId };
    await s.setCard(o.userId, c);
    const text = emailCardText(c.payload, lead === "changed");
    return { reply: lead && lead !== "changed" ? `${lead}\n\n${text}` : text, status: "shown", waiting: true, card_id: c.id };
  };
  const done = (reply: string, status: string): EmailTurn => ({ reply, status, waiting: false });
  if (r.kind === "apply") {
    // A new request replaces any card still waiting: a later yes is never for an email shown before this request.
    const old = await s.card(o.userId);
    if (old && old.state === "shown") await s.setCard(o.userId, { ...old, state: "declined" });
    const found = (await s.postings(r.company)).filter((p) => p.apply_email && sameCompany(p.company, r.company))
      .filter((p) => !r.title || roleOverlap(p.title, r.title) >= 0.5);
    if (!found.length) return done(`I don't see an open posting at ${clip(r.company, 80)} that asks for applications by email.`, "none");
    const onFile = await resumeState(o.deps);
    if (onFile === "unknown") return done(RESUME_UNREAD_EMAIL, "resume_unreadable");
    if (onFile === "missing") return done(NO_RESUME_EMAIL, "no_resume");
    if (found.length > 1) {
      const titles = found.slice(0, 5).map((p, i) => `${i + 1}. ${clip(p.title, 80)}`);
      return done([`${clip(found[0].company, 80)} has ${found.length} postings that take applications by email:`, ...titles, `Say "apply by email to ${clip(found[0].company, 80)} for" and the title.`].join("\n"), "which");
    }
    const resume = await o.deps.resume(o.userId, found[0]);
    const prep = await prepareEmail({ userId: o.userId, posting: found[0], profile: o.deps.profile(), resume, draft: o.deps.draft });
    if (!prep.ok) return done(prep.reply, prep.status === "NOT_WIRED" ? "no_resume" : prep.status);
    return await show({ payload: prep.payload, payload_hash: prep.hash }, null);
  }
  // A yes, a no or a change counts only for the card the thread's last word showed (its id), and only for a day.
  let card: EmailCard | null;
  try {
    const last = await s.lastAssistant(o.threadId);
    if (!last || last.intent !== EMAIL_INTENT || typeof last.meta?.email_card !== "string") return null;
    card = await s.card(o.userId);
    if (!card || card.id !== last.meta.email_card) return null;
  } catch (e) {
    console.error("email card: not read", e instanceof Error ? e.message : String(e));
    return null;
  }
  if (card.state !== "shown" || card.thread !== o.threadId) return null;
  const co = clip(card.payload.company, 80);
  if (Date.parse(card.shown_at) < o.now - DAY) return done(`That email is more than a day old, so nothing was sent. Say "apply by email to ${co}" for a fresh one.`, "expired");
  if (r.kind === "no") {
    await s.setCard(o.userId, { ...card, state: "declined" });
    return done("Dropped. Nothing was sent.", "declined");
  }
  if (r.kind === "subject" || r.kind === "body") {
    const value = r.kind === "subject" ? clean(r.value, 200).replace(/\n+/g, " ") : clean(r.value, 5000);
    if (!value) return { reply: `That ${r.kind} is empty, so nothing changed.`, status: "shown", waiting: true, card_id: card.id };
    const payload = { ...card.payload, [r.kind]: value } as EmailPayload;
    return await show({ payload, payload_hash: await hashApplyPayload(payload) }, "changed");
  }
  // The yes: exactly the payload on the card, checked by its hash here and again by the database.
  const hash = await hashApplyPayload(card.payload);
  if (hash !== card.payload_hash) return done(`Not sent: ${REFUSED.changed_since_yes}.`, "changed");
  // The owner's switch first: off, nothing is reserved and the Gmail grant is not even read. The card stays the thread's
  // last word, so a yes once sending is on sends exactly this email.
  if (o.deps.sendOn === false) {
    return { reply: `Not sent: sending email from your Gmail is not switched on in Trainee yet. Nothing went to ${co}. The email is kept as drafted; you can copy it and send it yourself, or say yes again once sending is on.`, status: "SEND_OFF", waiting: true, card_id: card.id };
  }
  if (!(await o.deps.canSend(o.userId))) {
    // The card stays this thread's last word: once Gmail is connected, a yes sends it.
    return { reply: "NOT_WIRED: not sent. Trainee can't send from your Gmail yet. Connect Gmail in the Trainee app (it asks to send on your behalf), then say yes again.", status: "NOT_WIRED", waiting: true, card_id: card.id };
  }
  // The resume rule again at the yes: a resume deleted or replaced since the card was shown sends nothing.
  const onFile = await resumeState(o.deps);
  // Unknown: nothing is reserved or sent; the card stays this thread's last word, so a yes once it can be read sends it.
  if (onFile === "unknown") return { reply: `Not sent: I couldn't check your resume on file just now, so nothing went to ${co}. Say yes again in a minute.`, status: "resume_unreadable", waiting: true, card_id: card.id };
  if (onFile === "missing") return done(`Not sent: ${REFUSED.no_resume}. Nothing went to ${co}.`, "no_resume");
  const resume = await o.deps.attachment(o.userId, card.payload.attachment.sha256);
  if (!resume || resume.sha256 !== card.payload.attachment.sha256 || (await sha(resume.bytes)) !== resume.sha256) {
    return done(`Not sent: your resume file is not the one on this email. Say "apply by email to ${co}" for a fresh one.`, "resume_changed");
  }
  let job: { id: string; lease_token: string };
  try {
    job = await s.reserve(o.userId, card.payload, hash);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const why = Object.keys(REFUSED).find((k) => msg.includes(k));
    if (!why) throw e;
    return done(`Not sent: ${REFUSED[why]}. Nothing went to ${co}.`, why);
  }
  const p = card.payload;
  const res = await o.deps.send(o.userId, { to: p.to, subject: p.subject, body: p.body, attachment: { filename: p.attachment.filename, bytes: resume.bytes, mime: resume.mime } })
    .catch((e) => ({ status: "UNKNOWN" as const, detail: e instanceof Error ? e.message : String(e) }));
  if (res.status === "sent") {
    try {
      await s.finish(o.userId, job.id, job.lease_token, "submitted_unconfirmed", { reason: "emailed from the person's Gmail", sent_at: at, message_hash: res.idHash, to: p.to, subject: p.subject });
    } catch (e) {
      // Gmail took it, but the record failed: the application is marked unknown (never sent again) where it can be, and
      // the person is told plainly. A row that cannot be written at all stays driving, which nothing ever resends.
      console.error("email apply: sent but not recorded", e instanceof Error ? e.message : String(e));
      await s.finish(o.userId, job.id, job.lease_token, "unknown_outcome", { reason: "sent from Gmail; the record failed", sent_at: at, message_hash: res.idHash })
        .catch((e2) => console.error("email apply: unknown not recorded either", e2 instanceof Error ? e2.message : String(e2)));
      return done(`Your Gmail sent it to ${p.to}, but Trainee couldn't record it, so it is marked unknown and will not be sent again. Check your Gmail's Sent folder.`, "unknown");
    }
    return done(`Sent to ${p.to} from your Gmail. I'm tracking it, and I'll mark it confirmed when ${co} writes back.`, "sent");
  }
  if (res.status === "NOT_WIRED" || res.status === "REFUSED") {
    // Nothing went. The same email is shown again as a new card, so a fresh yes may try it once more.
    await s.finish(o.userId, job.id, job.lease_token, "not_submitted", { reason: res.status === "NOT_WIRED" ? "NOT_WIRED" : res.detail, at });
    const why = res.status === "NOT_WIRED"
      ? "NOT_WIRED: not sent. Trainee can't send from your Gmail yet. Connect Gmail in the Trainee app, then say yes to this email again."
      : `Not sent: Gmail refused it (${res.detail}). Nothing went to ${co}. Here is the same email; say yes to try once more.`;
    return await show({ payload: p, payload_hash: hash }, why);
  }
  await s.finish(o.userId, job.id, job.lease_token, "unknown_outcome", { reason: res.detail, at });
  return done(`I can't tell whether the email to ${p.to} went, so I won't send it again. If it's in your Gmail's Sent folder, it went.`, "unknown");
}

// ------------------------------------------------------------------------------------------------ Supabase
// deno-lint-ignore no-explicit-any
export function supabaseEmailStore(admin: any): EmailStore {
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    async postings(company) {
      const word = clip(company, 80).replace(/[%_,()]/g, " ").split(" ").filter((w) => w.length > 1)[0] ?? "";
      if (!word) return [];
      return must(await admin.from("career_postings").select("job_id,company,title,url,description,apply_email").not("apply_email", "is", null)
        .is("closed_at", null).ilike("company", `%${word}%`).order("first_seen_at", { ascending: false }).limit(20), "read email postings") ?? [];
    },
    async card(u) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", EMAIL_CARD_KEY).maybeSingle(), "read the email card");
      const v = r?.value;
      return v && v.payload && typeof v.payload_hash === "string" && typeof v.id === "string" ? v as EmailCard : null;
    },
    async setCard(u, c) {
      must(await admin.from("career_watch_kv").upsert({ user_id: u, key: EMAIL_CARD_KEY, value: c }, { onConflict: "user_id,key" }), "keep the email card");
    },
    async lastAssistant(threadId) {
      const rows = must(await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply");
      const meta = rows?.[0]?.meta ?? null;
      return meta ? { intent: meta.intent ?? null, meta } : null;
    },
    async reserve(u, payload, hash) {
      const j = must(await admin.rpc("career_apply_email_reserve_as", { p_user: u, p_payload: payload, p_hash: hash }), "reserve the email application");
      return { id: j.id, lease_token: j.lease_token };
    },
    async finish(u, id, lease, state, evidence) {
      must(await admin.rpc("career_apply_email_finish_as", { p_user: u, p_id: id, p_lease: lease, p_state: state, p_evidence: evidence }), "record the email application");
    },
  };
}
// The resume to attach (WO-028 merged): the one tailored to this posting from the person's confirmed facts, which
// tailorForPosting renders, checks (truth audit, ATS parse) and stores privately at career-resumes/<user>/<sha256>.pdf.
// When it refuses (too few confirmed facts, no contact line), null: NOT_WIRED on the card. At the yes, the file on the
// card is read back by its hash, so what goes is byte for byte what was shown.
// deno-lint-ignore no-explicit-any
export function supabaseResumes(admin: any, o: { profile: () => any; tailor?: TailorDeps | null }) {
  const download = async (path: string): Promise<Uint8Array | null> => {
    const f = await admin.storage.from(RESUME_BUCKET).download(path);
    if (f?.error || !f?.data) return null;
    return new Uint8Array(await f.data.arrayBuffer());
  };
  return {
    async resume(u: string, p: EmailPosting): Promise<Resume | null> {
      if (o.tailor) {
        const t = await tailorForPosting({ userId: u, profile: o.profile(), posting: { text: `${p.title} at ${p.company}\n\n${p.description ?? ""}`, job_id: p.job_id, company: p.company }, deps: o.tailor, now: Date.now() })
          .catch((e) => { console.error("email apply: tailoring failed", e instanceof Error ? e.message : String(e)); return null; });
        if (t && t.ok) {
          const bytes = await download(resumePath(u, t.sha256));
          if (bytes && (await sha(bytes)) === t.sha256) return { filename: t.filename, bytes, sha256: t.sha256, tailored: true, mime: "application/pdf" };
        }
      }
      return null;
    },
    async attachment(u: string, sha256: string): Promise<Resume | null> {
      if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
      const tailored = await download(resumePath(u, sha256));
      return tailored && (await sha(tailored)) === sha256 ? { filename: "resume.pdf", bytes: tailored, sha256, tailored: true, mime: "application/pdf" } : null;
    },
  };
}
