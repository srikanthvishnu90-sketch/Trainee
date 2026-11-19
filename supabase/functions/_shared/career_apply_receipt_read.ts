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
  new RegExp(`^ ${LEAD}(?:${SHOW} )?(?:me )?(?:exactly |precisely |just )?what (?:exactly )?(?:did )?(?:you|trainee|we|it) (?:exactly )?(?:send|sent|submit|submitted|put|fill in|filled in|answer|answered|tell|told)(?: (?:in|on) (?:my|the) application)? (?:to|for|at|with) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}(?:exactly )?what (?:did|have) (?:you|trainee|we) (?:exactly )?(?:send|sent|submit|submitted|tell|told) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what (?:answers|information|info|details) (?:did|have) (?:you|trainee|we) (?:send|sent|submit|submitted|give|given|put)(?: (?:to|for|on|in))? (?:the |my )?(.+?)(?: application)?(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what (?:was|got) (?:sent|submitted) (?:to|for|at) (.+?)(?: exactly)? $`),
  new RegExp(`^ ${LEAD}what did my application (?:to|for|at|with) (.+?) (?:say|contain|include|have in it) $`),
];
const ALL = new RegExp(`^ ${LEAD}(?:${SHOW} )?(?:me )?(?:all )?(?:of )?(?:my )?(?:application )?receipts $`);
const NOT_A_COMPANY = /^(?:the|my|a|an|it|them|that|this|those|these|they|him|her|me|you|my application|the application|an application|my applications|applications|everything|anything|anyone|everyone|employers?|companies|the employer|the company)$/;

export function receiptAsk(message: string): { company: string | null } | null {
  const t = plain(message);
  if (ALL.test(t)) return { company: null };
  for (const re of ONE) {
    const m = re.exec(t);
    if (!m) continue;
    const lower = m[1].replace(/^(?:the|a|my) /, "").replace(/ (?:application|app)$/, "").trim();
    if (!lower || lower.length < 2 || lower.length > 80 || NOT_A_COMPANY.test(lower)) return null;
    const i = String(message).toLowerCase().indexOf(lower);
    return { company: i >= 0 ? String(message).slice(i, i + lower.length) : lower };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the reply
const when = (iso: string | null | undefined) => iso && Number.isFinite(Date.parse(iso))
  ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC"
  : null;
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

export function receiptText(r: ReceiptRow, pictures: ReceiptPicture[], now: number, more = 0): string {
  const lines = [`Receipt for your application to ${r.company}: ${headline(r)}`];
  lines.push(`Where: ${one(r.url, 500)}${r.final_url && r.final_url !== r.url ? ` (the page after Submit: ${one(r.final_url, 500)})` : ""}`);
  const times = [`approved ${when(r.approved_at) ?? "at a time not on record"}`, r.clicked_at ? `Submit clicked ${when(r.clicked_at)}` : null, `recorded ${when(r.finished_at) ?? "at a time not on record"}`].filter(Boolean);
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

const slug = (s: string) => one(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employer";

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
  return { reply: receiptText(r, pictures, o.now, mine.length - 1) + pictureNote, status: "shown", intent: RECEIPT_INTENT, ...(documents.length ? { result: { documents } } : {}) };
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
