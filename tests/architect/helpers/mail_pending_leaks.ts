// Secrets that still reach the model (mail_security.ts redacts only what a cue, a shape or a link marks; these have none of
// them). They are not allowed: each is asserted to leak NOWHERE in tests/architect/pending/mail-secrets-without-cue-20261113.test.ts,
// which fails until they are fixed. The architect tests that read the same tables skip exactly these and assert the rest.
// Round-2 table (tests/architect/helpers/mail_security_tables.ts), by name.
export const PENDING_59 = ["otp subject, generic words", "html only, neutral words", "otp spelled"];
// Round-3 table (tests/architect/helpers/mail_round3_tables.ts), by name.
export const PENDING_109 = ["3+3 split by word", "split lines 2", "percent disguise", "phone disguise", "year disguise", "zip disguise", "backup words", "seed 12", "seed 24", "seed numbered",
  "token subdomain words", "no scheme short path", "cvv words", "kennwort prose", "door code 3 digit", "dial-in pin"];
// Round-2 R4 inputs that still keep a secret, and the review's round-4 corpus (s6, s7, s10): [text, secrets].
export const PENDING_TEXTS: [string, string[]][] = [
  ["Aqui tienes: 558201. Type 48291377 or 1 2 3 4 5 6 or 123-456 or 55 81 92.", ["558201", "123-456", "55 81 92"]],
  ["Enter X7K9-QP2M or aB3dE9xQ or 7f3k-9d2m", ["7f3k-9d2m"]],
  ["Paste this where it asks:\n\n930 117\n\nThanks!", ["930 117"]],
  ["Hey! The portal gave me 772019 for you, put it in when it asks. Cheers, Jane", ["772019"]],
  ["First half: 482. Second half: 913. Enter both to log in.", ["482", "913"]],
];
