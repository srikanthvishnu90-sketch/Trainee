// The round-2 research battery's oracle, shared by the pure run (tests/architect/scenarios-research-r2.test.ts) and the Postgres
// run (tests/architect/flow-scenarios-research-r2.test.ts): what a reply to one turn of a conversation may say, judged
// independently of the product (round 1's subject and number oracles, plus each turn's own checks; see Turn in
// research-r2-generator.ts).
import { subjectViolation } from "./research-generator.ts";
import { unsourcedNumbers } from "./research-oracle.ts";
import { FILED } from "./letter-target-generator.ts";
import type { Turn } from "./research-r2-generator.ts";

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILED_FORMS = new Set(FILED.flatMap((f) => [f.name, ...f.typed]).map((x) => x.toLowerCase()));
const PLAIN: Record<string, RegExp> = {
  // (the inbox's own answer to "any news on Ramp?" — no email from them — is an answer too: it reads news as their reply)
  news: /\bholds no news\b|\bno news on record\b|\bcan't say whether there have been\b|\bNo email from\b/,
  people: /\bnames no people\b|\bdon't name anyone\b|\bwon't guess names\b/,
  office: /\bholds nothing on (?:a |its )?.{0,30}offices?\b|\boffice details\b|\bwhat the file says on\b/,
  rating: /\bjudgment, not a fact\b|\bno rating\b/,
};
// What the turn's reply breaks, if anything: `said` is every message of the conversation so far, this turn's last.
export function r2Violations(said: string[], turn: Turn, reply: string, intent: string): string[] {
  const out: string[] = [];
  const all = said.join("\n");
  const head = reply.split("\n")[0].trim();
  const subj = subjectViolation(all, reply);
  if (subj) out.push(`subject: ${subj}`);
  const nums = unsourcedNumbers(reply, all);
  if (nums.length) out.push(`numbers: no source holds ${nums.join(", ")}`);
  for (const c of turn.checks) {
    const [kind, arg = ""] = c.split(/:(.*)/s);
    if (kind === "no-false-nofile") {
      for (const m of reply.matchAll(/(?:^|\n|\.\s)([A-Z][^\n.]{0,60}?) has no company file/g)) if (FILED_FORMS.has(m[1].trim().toLowerCase())) out.push(`false-nofile: "${m[0].trim()}" (it has one)`);
      if (/the other does not/.test(head) && FILED.filter((f) => head.includes(f.name)).length >= 2) out.push(`false-nofile: ${head}`);
    } else if (kind === "about") {
      if (!head.includes(arg)) out.push(`about: the follow-up is about ${arg}, the reply's headline is "${head.slice(0, 90)}"`);
    } else if (kind === "plain") {
      if (!PLAIN[arg].test(reply)) out.push(`plain: the ${arg} asked about is not on record, and the reply does not say so`);
    } else if (kind === "compare") {
      const sides = arg.split("|");
      const missing = sides.filter((n) => !reply.includes(n));
      if (missing.length) out.push(`compare: ${missing.join(", ")} left out`);
      if (/has no company file|the other does not/.test(reply)) out.push(`compare: a filed side said to have no file`);
    } else if (kind === "nofile") {
      if (!reply.includes(`${arg} has no company file`)) out.push(`nofile: no "${arg} has no company file"`);
    } else if (kind === "nofile-said") {
      if (!new RegExp(`${esc(arg)} has no company file|No company file on file for ${esc(arg)}|No record for ${esc(arg)}|nothing (?:in this plan |here )?is about how ${esc(arg)}`).test(reply)) out.push(`nofile-said: ${arg}'s missing file is not said`);
    } else if (kind === "firm-named") {
      if (/Company: not supplied yet/.test(reply)) out.push(`firm-named: "Company: not supplied yet" though ${arg} was named`);
    } else if (kind === "not-finance") {
      if (/finance question|three financial statements/i.test(reply)) out.push("not-finance: a banking question for a tech firm's technical round");
    } else if (kind === "no-canon") {
      if (/book canon|bookshelf/i.test(reply)) out.push("no-canon: a reading list served as a question");
    } else if (kind === "ask-them") {
      if (!/questions to ask/i.test(reply)) out.push("ask-them: no questions to ask them");
    } else if (kind === "pay-section") {
      if (!/\bcomp, from the file\b|\bComp:|\bno (?:compensation|pay) figure\b|\bpay figure\b|has no company file/i.test(reply)) out.push("pay-section: the firm's comp section is not given");
    } else if (kind === "not-said") {
      if (new RegExp(`\\$?${arg}(?:k\\b|,000\\b)`, "i").test(reply)) out.push(`not-said: the person's current pay ${arg}k said back`);
    } else if (kind === "no-action") {
      if (/apply|queue|submit/i.test(intent) && !/guidance|advice|intel/i.test(intent)) out.push(`no-action: intent ${intent}`);
      if (/\bqueued\b|\bI applied\b|\bapplication (?:is |was )?(?:sent|submitted)\b/i.test(reply)) out.push("no-action: the reply claims an application");
    }
  }
  return out;
}
