// Google verification (owner, 2026-10-26: "yes start google's verification"). The one list of Google OAuth scopes Trainee
// submitted for verification, and the one filter every consent URL goes through, so the live app never asks Google for a
// scope the submission did not name. Google refuses a verified app's consent for a sensitive or restricted scope that was
// not approved, and its policy is "only request the narrowest scopes" for features that exist today
// (support.google.com/cloud/answer/13464321). docs/launch/GOOGLE-VERIFICATION-2026-10-26.md §1 gives the reason for each.
//
//   openid, email   non-sensitive: name the Google address that granted access (shown back to the person).
//   gmail.readonly  restricted: the code an application system emails during an application the person approved
//                   (career_email_code.ts), and job-mail status tracking (career_mail_gmail.ts, metadata + snippet).
//   gmail.send      sensitive: DEFERRED. Every sender is behind an owner switch that is off (CAREER_EMAIL_SEND,
//                   CAREER_OUTREACH_SEND), so it is not in the submission. Once Google approves it in a later
//                   submission, the owner adds it with GOOGLE_APPROVED_EXTRA_SCOPES (one full scope URL per word).
//   calendar.*      dropped: nothing in production reads or writes Calendar (career_capabilities.ts).
// Pure: no I/O, no env reads (the caller passes its env).

export const OPENID = "openid";
export const EMAIL = "email";
// Google echoes the "email" scope back on the token as this URL; both mean the same permission.
export const USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

// The submission of 2026-10-26, in the order the consent screen lists them.
export const SUBMITTED_SCOPES: readonly string[] = Object.freeze([OPENID, EMAIL, GMAIL_READONLY]);
// Scopes that only identify the account; they never decide what Trainee may do with mail.
export const IDENTITY_SCOPES: readonly string[] = Object.freeze([OPENID, EMAIL, USERINFO_EMAIL, "profile", "https://www.googleapis.com/auth/userinfo.profile"]);

const SCOPE_WORD = /^(?:openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+)$/;

// The extra scopes the owner says Google has approved since (GOOGLE_APPROVED_EXTRA_SCOPES, space or comma separated).
// Anything that is not a scope word is ignored, so a typo can never widen a request to something odd.
export function approvedExtras(env: { get(k: string): string | undefined }): string[] {
  return String(env.get("GOOGLE_APPROVED_EXTRA_SCOPES") ?? "").split(/[\s,]+/).filter((s) => SCOPE_WORD.test(s));
}

// What a consent URL may ask for: the asked scopes that were submitted (or approved since), plus openid and email so the
// connected address can be named. `dropped` lists what was asked and refused, for the caller to say so.
export function requestableScopes(asked: string[], env: { get(k: string): string | undefined }): { scopes: string[]; dropped: string[] } {
  const allowed = new Set([...SUBMITTED_SCOPES, ...approvedExtras(env)]);
  const want = [...new Set([...(asked ?? []).map(String).filter(Boolean)])];
  const scopes = [...new Set([OPENID, EMAIL, ...want.filter((s) => allowed.has(s))])];
  return { scopes, dropped: want.filter((s) => !allowed.has(s)) };
}

// The permission scopes of a grant, without the ones that only identify the account.
export function permissionScopes(scopes: string[]): string[] {
  return (scopes ?? []).filter((s) => !IDENTITY_SCOPES.includes(s));
}

// ------------------------------------------------------------------------------------------------ before consent
// The words a person reads on Trainee's own page before Google's consent screen (Google: in-product privacy notices "must
// be prominently displayed in your app interface"). Every line is true of the code on trunk; docs/launch/GOOGLE-
// VERIFICATION-2026-10-26.md §3 maps each one to the file that makes it true. Lines for a scope not asked are left out.
export const PRIVACY_URL_PATH = "/privacy#google";

// modelCheck: CAREER_MAIL_MODEL is on for the mail run (career-proactive), so an unclear email's masked sender name,
// subject and preview go to OpenAI's API for a second opinion (career_mail_model.ts mailModelPayload).
export function consentNotice(scopes: string[], o: { modelCheck?: boolean } = {}): { title: string; reads: string[]; never: string[]; undo: string[] } {
  const read = scopes.includes(GMAIL_READONLY), send = scopes.includes(GMAIL_SEND);
  const reads: string[] = [];
  if (read) {
    reads.push(
      "While an application you approved is being sent, the security code the application system (Greenhouse, Lever, Ashby or Workday) emails you, so Trainee can type it into that form. The code is used once and never stored.",
      "The sender, subject, date and Gmail's short preview of each new email (never the full email), to find employers' confirmations, rejections, interviews and replies and update your application tracker. For those, Trainee keeps only the result (for example \"Acme: interview\") and one short evidence line from the subject; for every other email it keeps nothing.",
    );
    if (o.modelCheck) reads.push("When an employer email is unclear, its sender name, subject and preview, with long numbers and email addresses masked, are checked by OpenAI's model for Trainee. OpenAI does not train on it.");
  }
  if (send) reads.push("Send one email you approved word for word in the chat, from your own Gmail. Nothing is sent without your yes to that exact email.");
  reads.push("Your Google email address, to show you which account you connected.");
  const never = [
    "Google will show the permission as \"View your email messages and settings\": it is the narrowest Google permission that can read an emailed code. Trainee uses it only to read those codes and to track your applications.",
    send ? "Trainee never sends an email you did not approve." : "Trainee can't send, delete, label or change any email.",
    "No person at Trainee reads your mail, unless you ask for help with specific emails, it is needed for security, or the law requires it. It is not used for ads, not sold, and not used to train AI models.",
    "Your Google password never reaches Trainee.",
  ];
  const undo = [
    "Say \"disconnect gmail\" in the chat at any time: Trainee revokes its access at Google, deletes its stored tokens, and deletes the mail status events, drafts and read cursor it kept.",
    "You can also remove Trainee at myaccount.google.com/permissions.",
  ];
  return { title: "Before you connect Gmail", reads, never, undo };
}
