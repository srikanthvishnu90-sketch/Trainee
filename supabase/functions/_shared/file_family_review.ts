// Item 6, S1 (VERIFICATION-15 item 6; coordinator brief f-s1): the live F-09 Application review File, through the one S0 hook
// (file_family_serve.ts FamilyRecords; FileDeps.familyRecords["F-09"]). The File (file_service.ts createReview, the card's review link)
// names one prepared application (data.ref { prepared, job }, live), and every GET builds the page from the records as they are
// now: the prepared application row (career_apply_prepared), the posting's title, the posting's still-open required questions, the
// person's resume-version record, and the application record (career_apply_jobs) for where it stands. Nothing on it is a model's words.
//
// What the page shows: the role and the company; the resume in words (name, version, what it targets, the date it was made; never a
// hash prefix); every answer word for word with where it came from; every open required question named in the form's own words.
// Its two posts carry the page token (the File server checks the cookie, the token and the site before dispatching them):
//   approveapp {app, hash}  approves exactly the prepared application the page showed at exactly the payload hash it showed (D-MS-1).
//                           The hash is checked against the prepared application as it is now, and again by the database inside the
//                           one approving transaction (career_apply_card_confirm_as). A stale hash approves nothing (409), and the
//                           reply reads back both approval ids and why.
//   checkstatus {app}       reads the application record now and says its one stage (application_review.ts stageOf). Changes nothing.
// Every other control is the chat with the question filled in (file_family_serve.ts servedAct), a source page, or the export.
import type { Act, KV } from "./file_family.ts";
import type { ApplicationReview } from "./file_family_apply.ts";
import type { FamilyPostResult, FamilyRec, FamilyRecords } from "./file_family_serve.ts";
import { type ReviewDeps, type ReviewItem, resumeLabelOf, reviewOf, type Stage, STAGE_LABEL, STAGE_NOTE, stageOf } from "./application_review.ts";
import type { CardResult } from "./career_apply_cards.ts";
import { recordEvents } from "./agent/timeline.ts";
import { byHandUrl, type JobDeps, type PreparedRow, secretFields, unsendable } from "./telegram_jobs.ts";
import type { AppRow } from "./file_page.ts";

const HASH = /^[0-9a-f]{64}$/;
export const approvalId = (hash: string) => String(hash ?? "").slice(0, 12);
const NOTHING = "Nothing was approved or sent.";
const caution = (s: Stage) => s === "uncertain" || s === "failed" || s === "needs_you";

// What the F-09 records read, for one person (deps.ts wires the service-role reads, each scoped to that person).
export interface ReviewRecordDeps {
  review(userId: string): Pick<ReviewDeps, "prepared" | "titles" | "open" | "versions">; // application_review_links.ts supabaseReviewDeps
  current(userId: string, jobId: string): Promise<PreparedRow | null>; // the newest ready prepared application for the posting
  appRow(userId: string, jobId: string, url?: string): Promise<AppRow | null>; // the application record, once approved
  cards: JobDeps["cards"]; account?: JobDeps["account"]; events?: JobDeps["events"];
}

// The prepared application this File names, read now, as a review item (reviewOf: the payload's own words only).
async function itemOf(userId: string, ref: Record<string, string> | null | undefined, d: ReviewRecordDeps): Promise<{ item: ReviewItem; hash: string; at: string | null } | null> {
  const id = String(ref?.prepared ?? "");
  if (!id) return null;
  const r = d.review(userId), rows = await r.prepared([id]), row = rows.find((x) => x.id === id);
  if (!row || !HASH.test(String(row.payload_hash ?? ""))) return null;
  const job = String(row.job_id ?? ref?.job ?? "");
  const [titles, open, versions]: [Map<string, string>, { label: string; options?: string[]; job_ids?: string[] }[], Record<string, { n: number; at?: string | null }>] = await Promise.all([
    r.titles ? r.titles(job ? [job] : []).catch(() => new Map<string, string>()) : new Map<string, string>(),
    r.open && job ? r.open([job]).catch(() => []) : [],
    r.versions ? r.versions().catch(() => ({})) : Promise.resolve({}),
  ]);
  const v = versions[String(row.payload?.resume_sha256 ?? "")];
  const item = reviewOf({ ...row, title: titles.get(job) ?? null, open: open.filter((q) => !q.job_ids || q.job_ids.includes(job)),
    resume_version: v && Number.isInteger(v.n) && v.n > 0 ? { n: v.n, at: typeof v.at === "string" ? v.at : null } : null });
  const at = row.created_at && Number.isFinite(Date.parse(row.created_at)) ? new Date(Date.parse(row.created_at)).toISOString() : null;
  return { item: { ...item, job_id: item.job_id ?? (job || null) }, hash: String(row.payload_hash), at };
}

// The F-09 builder's input (file_family_apply.ts applicationReviewFile), from the review item and where the application stands.
export function reviewView(item: ReviewItem, hash: string, o: { stage: Stage | null; replaced?: boolean; preparedAt?: string | null; tz?: string | null }): ApplicationReview {
  const role = item.role, company = item.employer, stage = o.stage ?? "prepared";
  const resume = item.resume && item.resume_meta ? resumeLabelOf(item.resume_meta, o.tz) : item.resume?.label ?? null;
  const pkg: KV[] = [
    { k: "Role", v: role, src: role ? { label: "The posting" } : null, missing: "Not on the posting record" },
    { k: "Company", v: company, src: { label: "The prepared application" } },
    { k: "Resume", v: resume, src: resume ? { label: "Your confirmed resume file" } : null, missing: "None, so this cannot be sent", tone: resume ? undefined : "bad" },
    ...(item.letter ? [{ k: "Cover note", v: "Its full text is under the answers", src: { label: "Drafted by Trainee" } }] : []),
  ];
  const answers = [...item.answers.map((a) => ({ q: a.question, a: a.answer, required: true, src: { label: a.source ?? "Source not on record" } })),
    ...item.unresolved.map((u) => ({ q: u.question, a: null, required: true }))];
  let approve: Act = { label: "Approve submission", effect: "submit", post: { token: "", action: "approveapp", fields: { app: item.id, hash } } };
  if (stage !== "prepared") approve = { ...approve, post: undefined, off: `${STAGE_LABEL[stage]}. Nothing more is approved from this page.` };
  else if (o.replaced) approve = { ...approve, post: undefined, off: "A newer version of this application was prepared since this File was made. Ask Trainee in the chat for its review." };
  else if (!item.resume && !item.unresolved.length) approve = { ...approve, post: undefined, off: "No confirmed resume is on this application, so it cannot be approved. Trainee never sends one without it." };
  const ids = [`A-${item.id.replace(/[^0-9a-z]/gi, "").slice(0, 6).toUpperCase()}`, item.job_id ? `R-${(item.job_id.split(":").pop() ?? "").replace(/[^0-9a-z-]/gi, "").slice(0, 12)}` : "R-?"];
  return {
    appId: ids[0], rid: ids[1], title: role ?? `Application to ${company}`, company, destinationMeta: "Prepared",
    destination: { label: item.url ? "read when prepared" : "not on record", href: item.url, at: o.preparedAt ?? null }, pkg, answers,
    open: item.unresolved.map((u) => ({ q: u.question, ask: u.ask, act: { label: `Answer "${u.question}"`, effect: "decide", href: `?answer=${encodeURIComponent(item.id)}` } })),
    conditions: [
      `Your yes approves exactly this application (approval ${approvalId(hash)}): this company, this role, this resume and these answers word for word.`,
      "If anything on it changes before you approve, nothing is approved and you get a fresh review.",
      ...(item.expires_at ? [`This review stops working at ${item.expires_at.slice(0, 16).replace("T", " ")} UTC.`] : []),
      "A different employer, role, resume, answer or a bigger batch needs a new review.",
    ],
    approve, edit: { label: "Edit materials", effect: "decide", href: `?edit=${encodeURIComponent(item.id)}` }, cancel: { label: "Don't send this application", effect: "danger", href: "?decide=cancel" },
    status: { tone: caution(stage) ? "caution" : "info", label: `Where it stands: ${STAGE_LABEL[stage]}.`, text: STAGE_NOTE[stage],
      act: { label: "Check status", effect: "decide", post: { token: "", action: "checkstatus", fields: { app: item.id } } } },
  };
}

const no = (title: string, text: string): FamilyPostResult => ({ ok: false, title, lines: [text, NOTHING] });

// approveapp: exactly the prepared application the page showed, at exactly the hash it showed, or nothing (D-MS-1).
export async function approveReviewed(userId: string, rec: FamilyRec, fields: URLSearchParams, d: ReviewRecordDeps, now: number): Promise<FamilyPostResult> {
  const app = fields.get("app") ?? "", hash = fields.get("hash") ?? "", ref = rec.data.ref ?? {};
  if (!app || app !== ref.prepared || !HASH.test(hash)) return no("Not approved", "That approval is not the one this page shows.");
  let got: Awaited<ReturnType<typeof itemOf>>;
  try { got = await itemOf(userId, ref, d); } catch { return no("Not approved", "I couldn't read the application just now. Try again in a minute."); }
  if (!got) return no("Not approved", "This application is no longer on record. Ask Trainee in the chat for a fresh review.");
  const { item } = got, job = String(item.job_id ?? ""), company = item.employer;
  const record = job ? await d.appRow(userId, job, item.url ?? undefined).catch(() => null) : null;
  if (record) return { ok: false, title: "Already in your applications", lines: [`${STAGE_LABEL[stageOf(record)]}. It was approved before, so it is not approved twice.`, NOTHING] };
  if (got.hash !== hash) return no("Not approved: the application changed after this page was shown", `This page showed approval ${approvalId(hash)}; the application on file is now approval ${approvalId(got.hash)}. Reload the page to review what it would send now.`);
  let prep: PreparedRow | null;
  try { prep = job ? await d.current(userId, job) : null; } catch { return no("Not approved", "I couldn't read the application just now. Try again in a minute."); }
  if (!prep || prep.id !== app) return no("Not approved: this is no longer the prepared application", `Approval ${approvalId(hash)} is no longer ready to approve (it was replaced or closed). Ask Trainee in the chat for a fresh review.`);
  if (prep.payload_hash !== hash) return no("Not approved: the application changed after this page was shown", `This page showed approval ${approvalId(hash)}; the application on file is now approval ${approvalId(prep.payload_hash)}. Reload the page to review what it would send now.`);
  if (item.unresolved.length) return no("Not approved: a required answer is still missing", item.unresolved[0].ask);
  if (!item.resume) return no("Not approved", "No confirmed resume is on this application. Trainee never sends one without it.");
  // deno-lint-ignore no-explicit-any
  const p = prep.payload as Record<string, any>;
  if (byHandUrl(prep.url) || byHandUrl(String(p?.destination ?? ""))) return no("Not approved", "It would go to LinkedIn, Indeed or Handshake, which Trainee never applies on for you. Apply there yourself.");
  if (p?.destination && !/^https?:\/\/\S+$/i.test(String(p.destination))) return no("Not approved", "Its application doesn't go to a web address.");
  if (secretFields(prep).length) return no("Not approved: a field needs you", "It has a field that needs a password, code or similar, and those never go through Trainee. Finish that part yourself on the employer's form.");
  const why = await unsendable(userId, prep, { account: d.account, now: () => now });
  if (why) return no("Not approved", `${why.charAt(0).toUpperCase()}${why.slice(1)}.`);
  if (!d.cards.confirm) return no("Not approved", "Approving from this page isn't switched on yet. Approve it in the chat.");
  let results: CardResult[];
  try { results = (await d.cards.confirm(userId, [prep.id], [hash])).results ?? []; } catch (e) {
    const m = String((e as Error)?.message ?? e), need = /needs_answer: (.+)$/.exec(m);
    if (need) return no("Not approved: a required answer is still missing", need[1]);
    if (/card_changed|invalid card/.test(m)) return no("Not approved: the application changed after this page was shown", `Approval ${approvalId(hash)} no longer matches the application on file. Reload the page to review what it would send now.`);
    return no("Not approved", "I couldn't open the approval just now. Try again in a minute.");
  }
  if (results.length === 1 && results[0].result === "queued") {
    await recordEvents(d.events ?? null, [{ user_id: userId, at: now, kind: "application_approved", subject: company, detail: { n: 1, result: "queued", via: "review file", approval: approvalId(hash) }, source: "card" }]).catch(() => 0);
    return { ok: true, title: "Approved, not sent yet", lines: [`Approval ${approvalId(hash)}, exactly as the review showed: queued to send to ${company}.`,
      "Not submitted yet: it counts as submitted only when the employer's page answers, and confirmed only with the employer's own evidence. Check status on the review shows where it stands."] };
  }
  if (results.length && results.every((x) => x.result === "duplicate")) return { ok: false, title: "Already in your applications", lines: ["It is not approved twice.", NOTHING] };
  return no("Not approved", `The approval came back "${results.map((x) => x.result).join(", ") || "empty"}".`);
}

// checkstatus: the application record now, in its one stage. Changes nothing.
export async function checkReviewed(userId: string, rec: FamilyRec, fields: URLSearchParams, d: ReviewRecordDeps): Promise<FamilyPostResult> {
  const ref = rec.data.ref ?? {};
  if ((fields.get("app") ?? "") !== ref.prepared) return { ok: false, title: "Not checked", lines: ["That is not the application this page shows. Nothing was changed."] };
  let record: AppRow | null;
  try { record = ref.job ? await d.appRow(userId, ref.job) : null; } catch { return { ok: false, title: "Couldn't check just now", lines: ["The status was not read. Nothing was changed. Try again in a minute."] }; }
  const stage = record ? stageOf(record) : "prepared";
  const at = record?.updated_at && Number.isFinite(Date.parse(record.updated_at)) ? [`Record updated ${new Date(Date.parse(record.updated_at)).toISOString().slice(0, 16).replace("T", " ")} UTC.`] : [];
  return { ok: true, title: `Checked now: ${STAGE_LABEL[stage]}`, lines: [STAGE_NOTE[stage], ...at, "Nothing was changed."] };
}

// FileDeps.familyRecords["F-09"].
export function reviewRecords(d: ReviewRecordDeps, now: () => number = Date.now): FamilyRecords {
  return {
    async load(userId, rec) {
      // A read that fails throws (the handler shows the error state); a prepared application no longer on record is the C.24
      // expired state: this review is gone, ask for a new one. Never a stale page.
      const got = await itemOf(userId, rec.data.ref, d);
      if (!got) return { state: { state: "expired", family: "F-09" }, asOf: new Date(now()).toISOString() };
      const job = String(got.item.job_id ?? "");
      const [record, current] = job ? await Promise.all([d.appRow(userId, job, got.item.url ?? undefined), d.current(userId, job).catch(() => null)]) : [null, null];
      const replaced = !record && !!current && current.id !== got.item.id;
      return { view: reviewView(got.item, got.hash, { stage: record ? stageOf(record) : null, replaced, preparedAt: got.at }), asOf: new Date(now()).toISOString() };
    },
    post: {
      approveapp: (userId, rec, fields, at) => approveReviewed(userId, rec, fields, d, at),
      checkstatus: (userId, rec, fields) => checkReviewed(userId, rec, fields, d),
    },
  };
}
