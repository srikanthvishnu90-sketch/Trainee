// What a prepared application's card may say, checked by the server against the application itself (FEATURE 17 review,
// F5). A hosted preparation runs in a sandbox that browses the employer's page; the page is not trusted, so neither is
// anything the sandbox sends. The card the person approves must say what the application sends: the bridge stores a
// prepared application only when every card line is derived from its payload by these rules, and nothing else is on it.
//
// The card (workers/career-browser/approve-first.ts prepare builds it with these same functions):
//   the employer's name (payload.company)
//   one line per answer, in the payload's order: "<mark><label>: <shown>" where <shown> is the value sent, or the form's
//     own reading of a choice ("Yes (checked)" / "No" for a box; for a select or radio the person's own confirmed answer
//     that filled it, its source value)
//   the resume line (the kept file's name, or the tailored persona, and the first 12 characters of its hash)
//   "Also sent, set by the employer's page, unchanged: <names>" when the payload names page fields
//   "The page runs a verification check (<kinds>); its token carries none of your answers" when there is one
//   "Sends to <destination>"
//   "Cover note: <payload.cover_note.text>" when the payload carries a cover note
//   WO-122 (D.4 6, never reused silently): a reused sensitive answer's line ends with reusedSourceSuffix, and no other does
// What the server cannot check: which option code of a select stands for the answer shown (only the page knows); the
// shown text is held to the person's own answer for that field, never free text.
import { mapQuestion } from "./question_map.ts";

export const CARD_MARK: Record<string, string> = { consent: "You agree: ", attestation: "Your statement: ", screen: "About this job: " };
export const cardFieldPrefix = (label: string) => `${CARD_MARK[mapQuestion({ label }).kind] ?? ""}${label}: `;
// WO-122: a sensitive answer (work rights, GPA, graduation) not given for this application says where it came from. It is
// reused when it comes from the person's confirmed-facts file, or from an answer they texted whose question row
// (source.job_ids, career_apply_answers_own_v2) does not list this posting; a texted answer whose row is unknown (v1, no
// job_ids) or one kept for this posting only (a job: key) is fresh and takes none. The date is the answer's own
// (source.at), in the person's own IANA zone (payload.tz, R7); with no zone, or no date, no date is said: a UTC day can
// be the wrong day. The only formatter of the suffix, for the worker's card, the extension's card and the server's check.
const SENSITIVE = new Set(["work_authorization", "sponsorship", "us_person", "citizenship", "gpa", "graduation_date"]);
const UTC_ALIAS = /^(etc\/)?(utc|uct|gmt|zulu|universal|greenwich)([+-]?0)?$/i;
function personTz(tz: unknown): string | null {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(tz) || tz.length > 64 || UTC_ALIAS.test(tz)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
// deno-lint-ignore no-explicit-any
export function reusedSourceSuffix(field: any, postingJobId: unknown, tz?: unknown): string {
  if (!SENSITIVE.has(mapQuestion({ label: String(field?.label ?? "") }).fact)) return "";
  const id = String(field?.factId ?? ""), src = field?.source && typeof field.source === "object" ? field.source : {};
  if (!id || /^(approved-local-resume|essay-draft):/.test(id) || String(src.key ?? "").startsWith("job:")) return "";
  if (id.startsWith("text-answer:")) {
    if (!Array.isArray(src.job_ids)) return ""; // freshness unknown: fails toward "fresh takes none"
    if (src.job_ids.map(String).includes(String(postingJobId ?? ""))) return "";
    const zone = personTz(tz), at = typeof src.at === "string" ? Date.parse(src.at) : NaN;
    if (zone && Number.isFinite(at)) {
      return ` (from your answer on ${new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(new Date(at))})`;
    }
  }
  return " (from your confirmed facts)";
}
export interface ResumeTag { tailored: true; persona: string | null }
// Architect ruling R6 (2026-11-10): the resume is named in human terms only (its name, or that it is tailored for this role);
// the hash it is bound by stays in the payload and the approval, never on the card. Nothing is said that is not known: no
// version or date is invented. `sha256` stays a parameter so every caller names the same file it binds.
export function resumeCardLine(filename: string, _sha256: string, tag?: ResumeTag | null): string {
  return tag?.tailored
    ? `Resume: ${tag.persona ?? "your base resume"}, tailored for this role`
    : `Resume: ${filename}`;
}
const VERIFY = /^The page runs a verification check \(([a-z0-9 ,._-]{1,120})\); its token carries none of your answers$/i;
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const BOOL_ON = new Set(["true", "on", "1", "yes", "checked"]);
const BOOL_OFF = new Set(["false", "off", "0", "no", ""]);

// Null when the card is the application's; otherwise why not, in plain words.
// deno-lint-ignore no-explicit-any
export function preparedCardProblem(payload: any, lines: unknown, kept: { filename: string } | null): string | null {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.fields)) return "no application";
  if (!Array.isArray(lines) || !lines.length || lines.some((l) => typeof l !== "string" || l.length > 600)) return "card lines malformed";
  const L = lines as string[];
  let i = 0;
  const next = () => L[i++];
  if (next() !== String(payload.company ?? "")) return "the card does not name the employer the application goes to";
  // deno-lint-ignore no-explicit-any
  const fields = payload.fields.filter((f: any) => f?.value !== payload.resume_sha256);
  for (const f of fields) {
    let line = next();
    const label = String(f?.label ?? "");
    const prefix = cardFieldPrefix(label);
    if (typeof line !== "string" || !line.startsWith(prefix)) return `the card leaves out or reorders "${label}"`;
    const suffix = reusedSourceSuffix(f, payload.job_id, payload.tz);
    if (suffix && !line.endsWith(suffix)) return `the card does not say where the answer to "${label}" came from`;
    line = line.slice(0, line.length - suffix.length);
    const shown = line.slice(prefix.length), value = f?.value;
    if (shown === String(value)) continue;
    const v = norm(value);
    if (shown === "Yes (checked)" && (value === true || BOOL_ON.has(v))) continue;
    if (shown === "No" && (value === false || BOOL_OFF.has(v))) continue;
    const own = f?.source && typeof f.source === "object" ? f.source.value : undefined;
    if (typeof own === "string" && own && norm(shown) === norm(own)) continue;
    return `the card shows "${label}" as something the application does not send`;
  }
  const sha = String(payload.resume_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(sha)) return "the application carries no resume";
  const tag = payload.resume_tailored === true ? { tailored: true as const, persona: typeof payload.resume_persona === "string" ? payload.resume_persona : null } : null;
  if (!tag && !kept) return "no kept resume to name";
  if (next() !== resumeCardLine(kept?.filename ?? "", sha, tag)) return "the card names another resume than the one sent";
  const pageFields = Array.isArray(payload.page_field_names) ? payload.page_field_names.map(String) : [];
  if (pageFields.length && next() !== `Also sent, set by the employer's page, unchanged: ${pageFields.join(", ")}`) return "the card leaves out what the page sets";
  if (L[i] !== undefined && VERIFY.test(L[i])) i++;
  if (next() !== `Sends to ${String(payload.destination ?? "")}`) return "the card does not say where it is sent";
  const note = payload.cover_note && typeof payload.cover_note === "object" ? String(payload.cover_note.text ?? "") : "";
  if (note && next() !== `Cover note: ${note}`) return "the card's cover note is not the one sent";
  if (i !== L.length) return "the card says more than the application carries";
  return null;
}
