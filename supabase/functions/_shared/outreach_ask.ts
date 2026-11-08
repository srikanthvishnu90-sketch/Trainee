// R9 OUTREACH ROUTING (2026-11-08): does a message ask to write to someone? The networking turn's own grammar
// (career_networking.ts parseNetworkingAsk) drafts the asks it can read exactly; one it cannot read (a typo in the verb,
// another language, a slang lead) fell to the router, which answered it from a keyword: "the internship timeline" got the
// career timeline, "how they got started" the company-intel recipe, "the recruiter at X" a question for their name and
// address the person had already given in their contacts. Such a turn belongs to the brain, which drafts from the
// person's contacts with the same tool and the same approval rule (career_tools.ts draft_outreach, D-MN-2).
// This only decides WHO answers; it never drafts, approves or sends anything.

// A word within one edit (an insertion, deletion, substitution or swap of neighbours) of another: "emaiil", "eail",
// "wite", "sedn", "reaach" for email, write, send, reach. Only for words of four letters or more.
export function nearWord(w: string, target: string): boolean {
  if (w === target) return true;
  if (w.length < 4 || target.length < 4 || Math.abs(w.length - target.length) > 1) return false;
  const a = w, b = target;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

const words = (t: string) => String(t ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// Verbs that ask to write to a person, in the languages the product reads (English, Spanish, Hindi in Latin script).
const VERBS = ["email", "write", "message", "escribele", "escribeles", "escribe", "escribir", "correo", "mandale", "enviale", "bhejo"];
// A verb that needs a neighbour to mean writing: "send ... a note", "reach out", "email karo", "manda un email".
const PAIRS: [string, string[]][] = [["reach", ["out"]], ["send", ["note", "email", "message", "line"]], ["drop", ["note", "line"]], ["shoot", ["note", "email", "message"]], ["manda", ["email", "correo", "mensaje"]], ["envia", ["email", "correo", "mensaje"]]];

export function writesToSomeone(message: string): boolean {
  const ws = words(message);
  if (!ws.length || ws.length > 60) return false;
  const near = (w: string, t: string) => nearWord(w, t);
  if (ws.some((w) => VERBS.some((v) => near(w, v)))) return true;
  return PAIRS.some(([v, next]) => ws.some((w, i) => near(w, v) && ws.slice(i + 1, i + 9).some((x) => next.some((n) => near(x, n)))));
}

// Someone to write to: a person or a role at a firm ("Maya at Stripe", "the recruiter at X", "Sara de Onyx", "X wale Zain
// ko", "the hiring manager there"). Without one, "email me the file" or "send me an email when it's done" is not outreach.
const ROLES = ["recruiter", "manager", "reclutador", "reclutadora", "recruiting", "talent"];
export function namesRecipient(message: string): boolean {
  const ws = words(message);
  if (ws.some((w) => ROLES.some((r) => nearWord(w, r)))) return true;
  // "<Name> at|from|de <Firm>", "<Firm> wale <Name> ko", "<Name> there".
  return /\b\p{Lu}[\p{L}'’-]+\s+(?:at|from|frrom|form|de|del|en)\s+\p{Lu}/u.test(message) || /\bwale\s+\p{Lu}[\p{L}'’-]+\s+ko\b/u.test(message) ||
    /\b\p{Lu}[\p{L}'’-]+\s+(?:there|ko)\b/u.test(message);
}

// An ask to write to a person or a role at a firm, read loosely (typos, Spanish, Hindi in Latin script).
export const outreachAsk = (message: string) => writesToSomeone(message) && namesRecipient(message);
