// WO-021 step 5, the receipt: each application that finished is said once, in one text, as it ended. Confirmed only
// with the employer's own confirmation; anything not sent says nothing reached the employer; an unknown outcome is
// said as unknown and is never resent. Every word is written here from the queue row, never by the model. The outbox
// keeps one text per key, ever (receipt:<application id>), so a run that repeats sends nothing twice.
export const FINAL_STATES = [
  "confirmed",
  "submitted_unconfirmed",
  "needs_user",
  "failed",
  "not_submitted",
  "unknown_outcome",
] as const;

// Employer and page text is other people's text: one line, bounded.
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const httpsUrl = (u: unknown) => (/^https:\/\/\S+$/.test(String(u ?? "")) ? String(u).slice(0, 500) : "");

// Why an application did not go, in the person's words. Each says whether anything reached the employer.
const NOT_SENT: Record<string, string> = {
  CAPTCHA_AT_SUBMIT: "a verification appeared at Submit and was not completed",
  APPROVED_APPLICATION_CHANGED: "the form changed after you approved it, so it was stopped",
  APPROVED_BODY_MISMATCH: "what the page tried to send was not exactly what you approved, so it was stopped",
  RESUME_CHANGED: "your resume file is not the one you approved",
  NO_RESUME: "no resume was attached to it, and Trainee never applies without your resume",
  HOST_REDIRECT_REFUSED: "the page tried to go somewhere other than the employer's own site",
  PERSON_DID_NOT_SUBMIT: "Submit was not pressed in the window within 10 minutes",
  IDENTITY_NUMBER_REQUESTED: "the form asks for an ID number, which Trainee never fills in",
  ACCOUNT_LOGIN_REQUIRED: "the employer's site needs you to sign in to an account first",
  // Since 20261029180000 such an application goes back to the queue and is sent once the site allows (no receipt until
  // it ends); this is said only by a database without that requeue.
  HOST_RATE_LIMITED: "the employer's site was turning visitors away for a while (too many requests), so nothing was filled in or sent",
  needs_answers: "the form has questions you have not answered yet",
  // MASS APPLY (2026-11-01): the posting's page was gone when it was sent (closed after you approved it).
  POSTING_CLOSED: "this posting closed before it could be submitted",
};
const NEEDS_YOU: Record<string, string> = {
  captcha: "the page asks you to complete a verification",
  email_code: "the employer emailed you a code to finish it",
  // WO-039: the cloud met a verification check, which Trainee never solves or gets around. The link is theirs to finish.
  // FEATURE 17: what to do, exactly: open the link, enter the answers they approved (the card has them), complete the
  // check, press Submit. The check stopped it before Submit, so nothing reached the employer.
  bot_check: "a verification check appeared, and Trainee never solves one, so finish this one yourself: open the link below, " +
    "enter the answers you approved on the card, complete the check on the page, then press Submit",
  // Mass submission: the employer's site asks you to sign in to an account; Trainee never signs in for you.
  login_required: "the employer's site asks you to sign in to an account first, and Trainee never signs in for you, so finish this one yourself at this link",
};

// WO-032: a row is confirmed only by the employer's email matched to it (career_apply_confirm.ts); its receipt says whose
// email and when. A page's "thank you for applying" is kept as evidence and said as what it is, never as confirmation.
// The date is the person's own (their alert time zone), UTC when it is not known or not a zone.
const emailDay = (iso: unknown, tz?: unknown) => {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const day = (timeZone: string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  try { return day(typeof tz === "string" && tz ? tz : "UTC"); } catch { return day("UTC"); }
};
export function receiptText(
  row: {
    company?: unknown; url?: unknown; state: string; reason?: unknown; confirmation_id?: unknown;
    email_confirmed_at?: unknown; evidence?: { page_confirmation?: unknown } | null; source?: unknown; tz?: unknown;
  },
): string {
  const company = clean(row.company, 80) || "the employer", url = httpsUrl(row.url);
  const tail = url ? ` ${url}` : "";
  const reason = clean(row.reason, 200);
  switch (row.state) {
    case "confirmed": {
      if (row.email_confirmed_at) {
        const when = emailDay(row.email_confirmed_at, row.tz);
        return `Applied to ${company}: confirmed by ${company}'s email${when ? ` on ${when}` : ""}.${tail}`;
      }
      const id = clean(row.confirmation_id, 60);
      return `Applied to ${company}: the employer confirmed it on their page${
        id ? ` (confirmation ${id})` : ""
      }.${tail}`;
    }
    case "submitted_unconfirmed":
      if (row.source === "email") return `Emailed your application to ${company} from your Gmail. Their reply is the proof; I'll mark it confirmed when it comes.${tail}`;
      if (row.evidence?.page_confirmation === true) {
        return `Sent to ${company}. Their page said it was received; their confirmation email is the proof, and I'll mark it confirmed when it comes.${tail}`;
      }
      return `Sent to ${company}. The employer has not confirmed it yet; their confirmation email is the proof.${tail}`;
    case "needs_user":
      if (reason === "bot_check") return `${company} is not finished: ${NEEDS_YOU.bot_check}. Nothing reached ${company}.${tail}`;
      return `${company} is not finished: ${NEEDS_YOU[reason] ?? "it needs you"}. Nothing else was sent.${tail}`;
    case "failed":
      return `${company} did not accept it${reason ? `: their form said "${reason}"` : ""}.${tail}`;
    case "not_submitted": {
      // G6: the queue's claim records its own reason in words ("not sent: the application changed after it was approved");
      // that is said as the reason, not wrapped in a second "not sent".
      const said = /^not sent: /i.test(reason) ? reason.replace(/^not sent: /i, "").replace(/[.\s]+$/, "") : "";
      return `Not sent to ${company}: ${
        NOT_SENT[reason] ?? (said || `it stopped before sending${reason ? ` (${reason})` : ""}`)
      }. Nothing reached the employer.${tail}`;
    }
    case "unknown_outcome":
      return `${company}: Trainee cannot tell whether it went through, and will not send it again. If they email you a confirmation, it did.${tail}`;
    default:
      throw Error("not a finished application: " + row.state);
  }
}

export interface ReceiptRow {
  id: string;
  user_id: string;
  company?: string;
  url?: string;
  state: string;
  reason?: string | null;
  confirmation_id?: string | null;
  email_confirmed_at?: string | null;
  evidence?: { page_confirmation?: boolean } | null;
  source?: string | null;
}
export function planReceipts(rows: ReceiptRow[], now: number) {
  return rows
    .filter((r) => (FINAL_STATES as readonly string[]).includes(r.state))
    .map((r) => ({
      userId: r.user_id,
      key: `receipt:${r.id}`,
      kind: "receipt" as const,
      text: receiptText(r),
      at: now,
    }));
}
