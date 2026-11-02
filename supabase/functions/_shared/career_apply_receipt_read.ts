// FEATURE 14 (D-024; BACKEND-GAP-MAP G6): "show me the receipt for Stripe", "what did you send to Acme". The receipt each
// finished application gets (career_apply_receipts, written by the database when the queue's row finishes; migration
// 20261026140000_career_apply_receipt_store.sql), read back in chat by code, before the router or any brain:
//   - what was sent, field by field, each answer with the fact it came from, exactly as approved;
//   - where (the employer, the posting's page, the page it ended on) and when (approved, Submit clicked, recorded);
//   - the payload hash and the approval reference, the resume file's hash;
//   - the employer's confirmation id and what their page said after the click (their words, bounded);
//   - the two pictures of the proof (the page just before Submit was clicked, the page after it), attached through the
//     channel artifact path (channel_artifacts) as the turn's documents; never a public link.
// Only the person's own receipts are read (the service role reads with the turn's user id); another person's receipt is
// never found, named or hinted at. A receipt that cannot be read is said so, never guessed. Every word is code's.
import { statusLine } from "./career_apply_status.ts";
import { sameCompany } from "./career_mail.ts";

export const RECEIPT_INTENT = "career_apply_receipt";

export interface ReceiptAnswer { name?: string; label?: string; answer?: unknown; fact_id?: string; provenance?: string; source?: { table?: string; key?: string } }
export interface ReceiptRow {
  application_id: string; company: string; url: string; final_url?: string | null; state: string; reached_employer: "yes" | "unknown" | "no";
  reason?: string | null; answers: ReceiptAnswer[]; resume_sha256?: string | null; payload_hash: string; approval_hash: string;
  engine_approval?: string | null; approved_at: string; clicked_at?: string | null; finished_at: string; confirmation_id?: string | null;
  confirmation_text?: string | null; proof?: Record<string, any> | null; pictures_keep_until: string;
}
export interface ReceiptPicture { kind: "before-click" | "after-submit"; sha256: string; bytes_b64: string }
export interface ReceiptReader {
  list: (userId: string) => Promise<ReceiptRow[]>;
  pictures: (userId: string, applicationId: string, now: number) => Promise<ReceiptPicture[]>;
  // The person's own zone (career_alert_prefs.tz), for the times shown. Absent: UTC, said.
  zone?: (userId: string) => Promise<string | null>;
}
export interface ReceiptDocument { kind: "document"; filename: string; mime: string; base64: string; sha256: string }
export interface ReceiptTurn { reply: string; status: string; intent: string; result?: { documents: ReceiptDocument[] } }

// ------------------------------------------------------------------------------------------------ the asks
const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()} `;
const LEAD = "(?:so |ok |okay |hey |please |trainee,? )*(?:can you |could you |can i |could i |would you |please )?(?:please )?";
const SHOW = "(?:show me|show|send me|send|give me|give|get me|get|pull up|let me see|see|view|i want to see|i'd like to see|where'?s|where is|what'?s|what is)";
const RECEIPT = "(?:(?:the |my |a )?(?:application )?(?:receipt|receipts|proof|screenshots?|confirmation receipt))";
const APP = "(?:(?:my |the )?(?:application|app|job application)(?: (?:to|for|at|with))? )";
const ONE: RegExp[] = [
  new RegExp(`^ ${LEAD}(?:${SHOW} )?${RECEIPT} (?:for|of|from|on) ${APP}?(.+?)(?: application| app)? $`),
  new RegExp(`^ ${LEAD}(?:${SHOW} )?(?:the |my )?(.+?) (?:application |app )?(?:receipt|proof|screenshots?) $`),
  new RegExp(`^ ${LEAD}(?:${SHOW} )?(?:me )?what (?:did )?(?:you|trainee|we|it) (?:send|sent|submit|submitted|put|fill in|filled in|answer|answered|tell|told)(?: (?:in|on) (?:my|the) application)? (?:to|for|at|with) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what (?:did|have) (?:you|trainee|we) (?:send|sent|submit|submitted|tell|told) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what (?:answers|information|info|details) (?:did|have) (?:you|trainee|we) (?:send|sent|submit|submitted|give|given|put)(?: (?:to|for|on|in))? (?:the |my )?(.+?)(?: application)?(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what (?:was|got) (?:sent|submitted) (?:to|for|at) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what did my application (?:to|for|at|with) (.+?) (?:say|contain|include|have in it) $`),
];
const ALL = new RegExp(`^ ${LEAD}(?:${SHOW} )?(?:me )?(?:all )?(?:of )?(?:my )?(?:application )?receipts $`);
const NOT_A_COMPANY = /^(?:the|my|a|an|it|them|that|this|those|these|they|him|her|me|you|my application|the application|an application|my applications|applications|everything|anything|anyone|everyone|employers?|companies|the employer|the company)$/;
// Reqs doc 2 Q451: an audit ("prove you applied", "how do I know you actually applied to Acme?") is answered from the
// receipts in one message: employer-confirmed apart from sent-not-confirmed, each with its confirmation and times.
const YOU = "(?:you|trainee|u)";
const APPLIED = `(?:actually |really |even )?(?:applied|apply|submitted|submit|sent|send)(?: (?:it|them|those|these|that|my applications?|the applications?|anything))?`;
// A time word ends the employer ("... to Acme yesterday"); an ask about a span of time with no employer ("did you actually
// apply to anything today?") is an activity ask (career_activity.ts), never a receipt.
const WHEN = "(?:today|tonight|this morning|this afternoon|yesterday|this week|last week|this past week|(?:in |over )?the (?:last|past) (?:\\d+|few|couple of|seven) days|(?:in |over )?the (?:last|past) week|lately|recently|so far)";
const WHEN_RE = new RegExp(`(?:^| )${WHEN}(?: |$)`);
const TO = `(?: (?:to|for|at|with) (.+?))?(?: (?:at all|for real|for me|yet|${WHEN}))*`;
const ANY = /^(?:any|anything|anywhere|anyone|anybody|something|everything|any (?:jobs?|roles?|applications?|apps|companies|employers|places|positions?|internships?|of them|of those|thing)|jobs?|roles?|internships?)$/;
// The employer as captured, less a trailing time word; null when nothing that names an employer is left.
function employerOf(raw: string): string | null {
  let c = raw.replace(/^(?:the|a|my) /, "").replace(/ (?:application|app)$/, "").trim();
  c = c.replace(new RegExp(`(?: (?:${WHEN}|yet|at all|for real|for me))+$`), "").trim();
  if (!c || new RegExp(`^${WHEN}$`).test(c) || ANY.test(c)) return null;
  return c;
}
const PROVE: RegExp[] = [
  new RegExp(`^ ${LEAD}(?:prove|proof|show me proof|show proof|give me proof|send me proof|i want proof|i need proof|where'?s the proof|where is the proof)(?: (?:it|that|of it))?(?: that)? ${YOU} ${APPLIED}${TO} $`),
  new RegExp(`^ ${LEAD}(?:prove it|prove that|proof|show me proof|show proof|give me proof|i want proof|i need proof|where'?s the proof|where is the proof)(?: (?:of|for) (?:my |the |all my |all the )?(?:applications?|apps|submissions?))?(?: (?:to|for|at|with) (.+?))? $`),
  new RegExp(`^ ${LEAD}(?:how (?:do|can|would) i know|how do i check|can you show (?:me )?that) ${YOU} (?:actually |really |even )?(?:applied|submitted|sent (?:it|them|my applications?))${TO} $`),
  new RegExp(`^ (?:so |ok |okay )?(?:did|have) ${YOU} (?:actually|really|even|truly) (?:apply|applied|submit|submitted|send|sent)(?: (?:it|them|my applications?|anything))?${TO} $`),
];

export function receiptAsk(message: string): { company: string | null; prove?: true } | null {
  const t = plain(message);
  if (ALL.test(t)) return { company: null };
  for (const re of PROVE) {
    const m = re.exec(t);
    if (!m) continue;
    const raw = (m[1] ?? "").trim();
    const lower = raw ? employerOf(raw) : "";
    // "anything today", "any jobs": an activity ask, left to its own turn; so is a bare ask about a span of time.
    if (lower === null || (!raw && WHEN_RE.test(t.trim()))) return null;
    if (!lower) return { company: null, prove: true };
    if (lower.length < 2 || lower.length > 80 || NOT_A_COMPANY.test(lower)) return { company: null, prove: true };
    const i = String(message).toLowerCase().indexOf(lower);
    return { company: i >= 0 ? String(message).slice(i, i + lower.length) : lower, prove: true };
  }
  for (const re of ONE) {
    const m = re.exec(t);
    if (!m) continue;
    const lower = employerOf(m[1]);
    if (!lower || lower.length < 2 || lower.length > 80 || NOT_A_COMPANY.test(lower)) return null;
    const i = String(message).toLowerCase().indexOf(lower);
    return { company: i >= 0 ? String(message).slice(i, i + lower.length) : lower };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the reply
// A time on the person's own clock with its zone's short name (career_alert_prefs.tz); UTC, said, when none is on file.
const zoneOk = (tz: string | null | undefined): tz is string => {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const when = (iso: string | null | undefined, tz?: string | null) => !(iso && Number.isFinite(Date.parse(iso))) ? null
  : zoneOk(tz) ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" })
  : new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const day = (iso: string | null | undefined) => iso && Number.isFinite(Date.parse(iso))
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
const one = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const shown = (v: unknown) => typeof v === "boolean" ? (v ? "Yes (checked)" : "No") : Array.isArray(v) ? v.map((x) => one(x, 200)).join(", ") : one(v, 600);
function sourceOf(a: ReceiptAnswer): string {
  const id = one(a.fact_id, 120);
  if (id.startsWith("text-answer:") || a.source?.table === "career_apply_questions") return "your answer in chat";
  const parts = [id ? `fact ${id}` : "", one(a.provenance, 160)].filter(Boolean);
  return parts.length ? parts.join(", ") : "no source fact on record";
}
const headline = (r: ReceiptRow) => statusLine({ id: r.application_id, company: r.company, state: r.state, reason: r.reason ?? null,
  confirmation_id: r.confirmation_id ?? null, created_at: r.approved_at, updated_at: r.finished_at });

export function receiptText(r: ReceiptRow, pictures: ReceiptPicture[], now: number, more = 0, tz?: string | null): string {
  const lines = [`Receipt for your application to ${r.company}: ${headline(r)}`];
  lines.push(`Where: ${one(r.url, 500)}${r.final_url && r.final_url !== r.url ? ` (the page after Submit: ${one(r.final_url, 500)})` : ""}`);
  const times = [`approved ${when(r.approved_at, tz) ?? "at a time not on record"}`, r.clicked_at ? `Submit clicked ${when(r.clicked_at, tz)}` : null, `recorded ${when(r.finished_at, tz) ?? "at a time not on record"}`].filter(Boolean);
  lines.push(`When: ${times.join("; ")}.`);
  const answers = Array.isArray(r.answers) ? r.answers : [];
  const verb = r.reached_employer === "no" ? "What you approved (not sent)" : r.reached_employer === "unknown" ? "What was being sent (whether it arrived is unknown)" : "What was sent";
  lines.push(answers.length ? `${verb}:` : `${verb}: no form answers are on record for this one.`);
  for (const a of answers) lines.push(`- ${one(a.label ?? a.name ?? "A field", 200)}: ${shown(a.answer)} (from ${sourceOf(a)})`);
  if (r.resume_sha256) lines.push(`Resume: the file with sha256 ${r.resume_sha256.slice(0, 12)}…`);
  if (r.confirmation_id) lines.push(`${r.company}'s confirmation: ${one(r.confirmation_id, 120)}.`);
  if (r.confirmation_text) lines.push(`What their page said after Submit: "${one(r.confirmation_text, 400)}"`);
  lines.push(`Approval: payload ${r.payload_hash.slice(0, 12)}…${r.engine_approval ? `, approval ${r.engine_approval.slice(0, 12)}…` : ""} (the exact application you approved).`);
  const kinds = new Set(pictures.map((p) => p.kind));
  if (kinds.size) {
    const names = [kinds.has("before-click") ? "the page just before Submit was clicked" : null, kinds.has("after-submit") ? "the page after it" : null].filter(Boolean).join(" and ");
    lines.push(`Pictures attached: ${names}. They are kept until ${day(r.pictures_keep_until)}.`);
  } else if (r.proof?.refused) {
    lines.push("No pictures: the proof that run returned was not this application's, so it was not kept.");
  } else if (Date.parse(r.pictures_keep_until) <= now && (r.proof?.before_click || r.proof?.after_submit)) {
    lines.push(`The pictures were kept until ${day(r.pictures_keep_until)} and have been removed.`);
  } else if (r.reached_employer !== "no") {
    lines.push("No pictures are on record for this one.");
  }
  if (more > 0) lines.push(`${more} earlier ${more === 1 ? "application" : "applications"} to ${r.company} ${more === 1 ? "has a receipt" : "have receipts"} too.`);
  return lines.join("\n");
}

// Q451: the audit answer, every receipt on record in one message. "Proof" is only what the employer confirmed; a page's
// thank-you or a clicked Submit is listed apart as sent-not-confirmed (our record, not theirs); an outcome nobody can see is
// said so; what was never sent is named as not sent. Every line is read from the receipt row; nothing is inferred.
const PROOF_SHOWN = 10;
function proofLine(r: ReceiptRow, i: number, tz?: string | null): string {
  const conf = r.confirmation_id ? `confirmation ${one(r.confirmation_id, 120)}` : "confirmed by their email (no confirmation number in it)";
  // The Submit click when it is on record; else only when the record was written, said as that, never as a Submit.
  const clicked = r.clicked_at ? `Submit clicked ${when(r.clicked_at, tz)}` : `no Submit click on record, recorded ${when(r.finished_at, tz) ?? "at a time not on record"}`;
  const tail = `${clicked}; posting ${one(r.url, 300)}`;
  if (r.state === "confirmed") return `${i}. ${r.company}: ${conf}; ${tail}`;
  if (r.state === "submitted_unconfirmed") return `${i}. ${r.company}: ${tail}${r.confirmation_text ? `; their page said "${one(r.confirmation_text, 160)}"` : ""}`;
  return `${i}. ${r.company}: ${tail}`;
}
function section(title: string, rows: ReceiptRow[], tz?: string | null): string[] {
  if (!rows.length) return [];
  const out = [`${title} (${rows.length}):`, ...rows.slice(0, PROOF_SHOWN).map((r, i) => proofLine(r, i + 1, tz))];
  if (rows.length > PROOF_SHOWN) out.push(`…and ${rows.length - PROOF_SHOWN} more.`);
  return out;
}
export function proofText(rows: ReceiptRow[], tz?: string | null): string {
  const confirmed = rows.filter((r) => r.state === "confirmed");
  const sent = rows.filter((r) => r.state === "submitted_unconfirmed");
  const unknown = rows.filter((r) => r.state === "unknown_outcome");
  const notSent = rows.filter((r) => !["confirmed", "submitted_unconfirmed", "unknown_outcome"].includes(r.state));
  const lines = [`Proof on record: ${confirmed.length} confirmed by the employer, ${sent.length} sent but not confirmed by the employer yet` +
    `${unknown.length ? `, ${unknown.length} I can't tell arrived` : ""}${notSent.length ? `, ${notSent.length} not sent` : ""}.`];
  if (!confirmed.length && !sent.length) lines.push("No application has reached an employer on record, so there is nothing to prove yet.");
  lines.push(...section("Confirmed by the employer", confirmed, tz));
  lines.push(...section("Sent, not confirmed by the employer yet (Trainee's record of the Submit, not theirs)", sent, tz));
  lines.push(...section("Can't tell whether it arrived (never sent again)", unknown, tz));
  if (notSent.length) lines.push(`Not sent: ${notSent.slice(0, PROOF_SHOWN).map((r) => r.company).join(", ")}${notSent.length > PROOF_SHOWN ? ` and ${notSent.length - PROOF_SHOWN} more` : ""}.`);
  const first = confirmed[0] ?? sent[0] ?? unknown[0];
  if (first) lines.push(`Ask "show me the receipt for ${first.company}" for every field that was sent and the pictures of the page before and after Submit.`);
  return lines.join("\n");
}

const slug = (s: string) => one(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employer";

// The person's saved zone, or null (UTC, said) when none is on file or it can't be read.
async function zoneOf(o: { userId: string; read: ReceiptReader }): Promise<string | null> {
  if (!o.read.zone) return null;
  try { return await o.read.zone(o.userId); } catch (e) { console.error("receipt zone:", e instanceof Error ? e.message : String(e)); return null; }
}

// One chat turn: null when the text is not a receipt ask (nothing is read).
export async function receiptTurn(o: { message: string; userId: string; now: number; read: ReceiptReader }): Promise<ReceiptTurn | null> {
  const ask = receiptAsk(o.message);
  if (!ask) return null;
  let rows: ReceiptRow[];
  try {
    rows = await o.read.list(o.userId);
  } catch (e) {
    console.error("receipt:", e instanceof Error ? e.message : String(e));
    return { reply: "I couldn't read your receipts just now, so I can't show what was sent. Nothing is guessed; ask me again in a minute.", status: "unreadable", intent: RECEIPT_INTENT };
  }
  const companies = [...new Set(rows.map((r) => r.company))];
  if (ask.prove && !ask.company) {
    if (!rows.length) return { reply: "No application receipts are on record yet, so there is nothing to prove: Trainee has not finished an application for you. Each one gets a receipt when it finishes.", status: "none", intent: RECEIPT_INTENT };
    return { reply: proofText(rows, await zoneOf(o)), status: "proof", intent: RECEIPT_INTENT };
  }
  if (!ask.company) {
    if (!rows.length) return { reply: "No application receipts are on record yet. Each application gets one when it finishes.", status: "none", intent: RECEIPT_INTENT };
    const list = rows.slice(0, 10).map((r) => `- ${headline(r)} (recorded ${day(r.finished_at) ?? "on a date not on record"})`);
    return { reply: [`Your application receipts, newest first:`, ...list, ...(rows.length > 10 ? [`…and ${rows.length - 10} more.`] : []),
      `Ask "show me the receipt for ${rows[0].company}" to see exactly what was sent, with the pictures.`].join("\n"), status: "listed", intent: RECEIPT_INTENT };
  }
  const mine = rows.filter((r) => sameCompany(r.company, ask.company));
  if (!mine.length) {
    const others = companies.slice(0, 8);
    return { reply: `No receipt for ${ask.company} is on record: Trainee has not finished an application to ${ask.company} for you.` +
      (others.length ? ` Receipts on record: ${others.join(", ")}.` : ""), status: "none", intent: RECEIPT_INTENT };
  }
  const r = mine[0];
  let pictures: ReceiptPicture[] = [], pictureNote = "";
  try {
    pictures = await o.read.pictures(o.userId, r.application_id, o.now);
  } catch (e) {
    console.error("receipt pictures:", e instanceof Error ? e.message : String(e));
    pictureNote = "\nThe pictures could not be read just now; ask me again in a minute.";
  }
  const documents: ReceiptDocument[] = pictures.map((p) => ({ kind: "document", filename: `receipt-${slug(r.company)}-${p.kind}.png`, mime: "image/png", base64: p.bytes_b64, sha256: p.sha256 }));
  return { reply: receiptText(r, pictures, o.now, mine.length - 1, await zoneOf(o)) + pictureNote, status: "shown", intent: RECEIPT_INTENT, ...(documents.length ? { result: { documents } } : {}) };
}

// The production reader: the service role, always filtered to the person who texted.
const COLUMNS = "application_id,company,url,final_url,state,reached_employer,reason,answers,resume_sha256,payload_hash,approval_hash,engine_approval,approved_at,clicked_at,finished_at,confirmation_id,confirmation_text,proof,pictures_keep_until";
// deno-lint-ignore no-explicit-any
export function supabaseReceipts(admin: any): ReceiptReader {
  return {
    async list(userId) {
      const r = await admin.from("career_apply_receipts").select(COLUMNS).eq("user_id", userId).order("finished_at", { ascending: false }).limit(200);
      if (r.error) throw new Error(`read the receipts: ${r.error.message}`);
      return (r.data ?? []) as ReceiptRow[];
    },
    async zone(userId) {
      const r = await admin.from("career_alert_prefs").select("tz").eq("user_id", userId).maybeSingle();
      if (r.error) throw new Error(`read the zone: ${r.error.message}`);
      return (r.data?.tz as string | undefined) ?? null;
    },
    async pictures(userId, applicationId, now) {
      const r = await admin.from("career_apply_receipt_files").select("kind,sha256,bytes_b64").eq("user_id", userId).eq("application_id", applicationId)
        .eq("bound", true).gt("keep_until", new Date(now).toISOString()).order("kind", { ascending: false });
      if (r.error) throw new Error(`read the receipt pictures: ${r.error.message}`);
      return (r.data ?? []) as ReceiptPicture[];
    },
  };
}

// For the status read model (career_standing.ts): which of the person's applications have a receipt, by company.
// deno-lint-ignore no-explicit-any
export async function receiptCompanies(admin: any, userId: string): Promise<string[]> {
  const r = await admin.from("career_apply_receipts").select("company").eq("user_id", userId).order("finished_at", { ascending: false }).limit(200);
  if (r.error) throw new Error(r.error.message);
  return [...new Set(((r.data ?? []) as { company: string }[]).map((x) => x.company))];
}
