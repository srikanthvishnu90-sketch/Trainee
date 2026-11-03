// WO-051: the mail second opinion, measured. Two modes.
//
// Default (no model, no network, no key): for every committed split, how much mail the rules are unsure of (certainty)
// and how much of that would be sent to the model (neverSent; the application filter is assumed to pass, as if the person
// had applied to every employer, so this is the most that is sent). For splits whose labels may be read (the tuning and
// read splits, and the spent blind sets), how many of the rules' mistakes fall inside what is sent: the most a perfect
// model could fix. Held-out splits print only the fractions (no label is read).
//   deno run --allow-read evals/career/mail-model-eval.ts [--only split,...] [--json]
//
// --model live (the owner runs it; never in CI): the rules, then the model on the mail sent, through the model gateway on
// Claude with the strict answer schema, every safety rule of career_mail_model.ts applied; prints rules-only against
// rules + model on the named splits, and the cost. Without ANTHROPIC_API_KEY it prints NOT_RUN and exits 0.
//   ANTHROPIC_API_KEY=... deno run --allow-read --allow-env --allow-net=api.anthropic.com evals/career/mail-model-eval.ts --model live --only blind300,blind240
import { classifyMail, type Classified, type MailKind, type MailMeta, STATUS_KINDS } from "../../supabase/functions/_shared/career_mail.ts";
import { certainty, type MailModel, mailModelConfig, mailModelWiring, neverSent, opinion, readVerdict, mailModelPayload } from "../../supabase/functions/_shared/career_mail_model.ts";
import { newMeter } from "../../supabase/functions/_shared/model_gateway.ts";
import set from "./mail-labels.json" with { type: "json" };
import blind from "./mail-blind.json" with { type: "json" };
import blind160 from "./mail-blind160.json" with { type: "json" };
import blind200 from "./mail-blind200.json" with { type: "json" };
import blind240 from "./mail-blind240.json" with { type: "json" };
import blind300 from "./mail-blind300.json" with { type: "json" };
import { dev4Splits, dev5Splits, dev6Splits, dev7Splits, splitsOf } from "./mail-eval.ts";

export interface LabeledMail extends MailMeta { id: string; split?: string; expect: { kind: string; company?: string } }
export function allSplits(): Record<string, LabeledMail[]> {
  const s = splitsOf(set.mails);
  return {
    dev: s.dev, devcheck: s.devcheck, holdout: s.holdout, blind40: blind.mails, ...dev4Splits(), blind160: blind160.mails, ...dev5Splits(),
    blind200: blind200.mails, ...dev6Splits(), blind240: blind240.mails, ...dev7Splits(), blind300: blind300.mails,
  } as unknown as Record<string, LabeledMail[]>;
}
// Labels never read here: the held-out quarters and checks. The spent blind sets and the read splits may be.
export const HELD_OUT = ["devcheck", "holdout", "blind40", "dev4check", "dev5check", "dev6check", "dev7check"];

const meta = (m: MailMeta): MailMeta => ({ from: m.from, subject: m.subject, snippet: m.snippet, date: m.date });
// What would be sent of a set, and why the rest is not; no label is read.
export function selection(mails: MailMeta[]) {
  const why: Record<string, number> = {};
  let uncertain = 0, sent = 0;
  for (const m0 of mails) {
    const m = meta(m0), c = certainty(m);
    if (!c.uncertain) continue;
    uncertain++;
    why[c.why] = (why[c.why] ?? 0) + 1;
    if (!neverSent(m)) sent++;
  }
  return { total: mails.length, uncertain, sent, why, fraction_uncertain: mails.length ? uncertain / mails.length : 0, fraction_sent: mails.length ? sent / mails.length : 0 };
}
// Of the rules' mistakes (wrong kind), how many are among the mail sent: the most a perfect second opinion could fix.
// The rest, by why they are not sent: a guard decided (a rule, never overridden), the scores were sure, or the words name
// no application (or another never-sent reason).
export function reach(mails: LabeledMail[]) {
  let wrong = 0, inside = 0;
  const outside = { guard: 0, sure: 0, never_sent: 0 };
  for (const m0 of mails) {
    const m = meta(m0), got = classifyMail(m).kind;
    if (got === m0.expect.kind) continue;
    wrong++;
    const c = certainty(m);
    if (!c.uncertain) outside[c.why === "guard" ? "guard" : "sure"]++;
    else if (neverSent(m)) outside.never_sent++;
    else inside++;
  }
  return { wrong, inside, outside };
}

// Status precision and recall of a list of (want, got) pairs, with the two worst confusions.
export function score(pairs: { want: string; got: string }[]) {
  let predicted = 0, right = 0, labeled = 0, found = 0, rejAsInterview = 0, rejForward = 0, wrongStatus = 0;
  const status = (k: string) => (STATUS_KINDS as string[]).includes(k);
  for (const { want, got } of pairs) {
    if (status(got)) { predicted++; if (got === want) right++; }
    if (status(want)) { labeled++; if (got === want) found++; }
    if (want === "rejection" && got === "interview") rejAsInterview++;
    if (want === "rejection" && ["interview", "assessment", "offer", "recruiter_reply"].includes(got)) rejForward++;
    if (status(want) && status(got) && got !== want) wrongStatus++;
  }
  return { precision: predicted ? right / predicted : 1, recall: labeled ? found / labeled : 1, predicted, labeled, rejection_as_interview: rejAsInterview, rejection_as_step_forward: rejForward, status_as_other_status: wrongStatus };
}

// Rules, then the model on what is sent, with every safety rule applied. The model is any function (a stub in tests).
export async function withModel(mails: LabeledMail[], model: MailModel) {
  const pairsRules: { want: string; got: string }[] = [], pairsBoth: { want: string; got: string }[] = [];
  const outcome: Record<string, number> = {};
  let asked = 0, changed = 0, offersFromModel = 0;
  for (const m0 of mails) {
    const m = meta(m0), rules: Classified = classifyMail(m);
    let got: MailKind = rules.kind;
    if (certainty(m, rules).uncertain && !neverSent(m)) {
      asked++;
      let v = null;
      try { v = readVerdict(await model(mailModelPayload(m)), true); } catch { outcome.model_error = (outcome.model_error ?? 0) + 1; }
      if (v) {
        const r = opinion(m, v, rules);
        outcome[r.why] = (outcome[r.why] ?? 0) + 1;
        if (r.decided) { got = r.decided.kind; changed++; if (got === "offer") offersFromModel++; }
      } else if (!outcome.model_error) outcome.unreadable = (outcome.unreadable ?? 0) + 1;
    }
    pairsRules.push({ want: m0.expect.kind, got: rules.kind });
    pairsBoth.push({ want: m0.expect.kind, got });
  }
  return { total: mails.length, asked, changed, offers_from_model: offersFromModel, outcome, rules: score(pairsRules), rules_and_model: score(pairsBoth) };
}

if (import.meta.main) {
  const pct = (x: number) => (100 * x).toFixed(1) + "%";
  const at = Deno.args.indexOf("--only"), only = at >= 0 ? String(Deno.args[at + 1] ?? "").split(",") : null;
  const mode = Deno.args.includes("--model") ? String(Deno.args[Deno.args.indexOf("--model") + 1] ?? "") : "";
  const splits = Object.entries(allSplits()).filter(([k]) => !only || only.includes(k));
  if (mode === "live") {
    const env = { get: (k: string) => { try { return Deno.env.get(k); } catch { return undefined; } } };
    const wired = mailModelWiring(env, null);
    if (!mailModelConfig(env).apiKey || wired.status !== "on") {
      console.log("NOT_RUN: no ANTHROPIC_API_KEY; the rules + model numbers were not measured and nothing was spent.");
      Deno.exit(0);
    }
    if (!only) { console.log("NOT_RUN: name the splits to spend on with --only (e.g. --only blind300,blind240)."); Deno.exit(0); }
    const meter = newMeter();
    for (const [name, mails] of splits) {
      const r = await withModel(mails, (payload) => wired.deps.call(payload, meter));
      console.log(`mail second opinion, SYNTHETIC set, ${name}: ${r.total} emails, ${r.asked} sent to the model, ${r.changed} changed`);
      for (const [label, s] of [["rules", r.rules], ["rules + model", r.rules_and_model]] as const) {
        console.log(`  ${label.padEnd(14)} precision ${pct(s.precision)} (${s.predicted}), recall ${pct(s.recall)} (${s.labeled}); rejection read as interview ${s.rejection_as_interview}; status as another status ${s.status_as_other_status}`);
      }
      console.log(`  outcomes: ${JSON.stringify(r.outcome)}; offers read by the model (said only on the employer's own mail): ${r.offers_from_model}`);
    }
    console.log(`cost: ${meter.calls} calls (${meter.failed} failed), ${meter.input_tokens} input + ${meter.output_tokens} output tokens, $${(meter.usd_micros / 1e6).toFixed(4)}${meter.unpriced ? ` (+${meter.unpriced} calls unpriced)` : ""}`);
    Deno.exit(0);
  }
  if (mode && mode !== "none") { console.log(`unknown --model ${mode}: use --model live (needs ANTHROPIC_API_KEY)`); Deno.exit(2); }
  const rows = splits.map(([name, mails]) => ({ name, ...selection(mails), reach: HELD_OUT.includes(name) ? null : reach(mails) }));
  if (Deno.args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log("mail second opinion (CAREER_MAIL_MODEL, off by default): what would be sent, no model called. SYNTHETIC sets.");
    for (const r of rows) {
      const reached = r.reach ? `; rules' mistakes among the mail sent ${r.reach.inside}/${r.reach.wrong} (not sent: ${JSON.stringify(r.reach.outside)})` : "; labels held out";
      console.log(`  ${r.name.padEnd(10)} ${String(r.total).padStart(4)} emails: unsure ${String(r.uncertain).padStart(3)} (${pct(r.fraction_uncertain)}), sent ${String(r.sent).padStart(3)} (${pct(r.fraction_sent)}) ${JSON.stringify(r.why)}${reached}`);
    }
    const t = rows.reduce((a, r) => ({ total: a.total + r.total, sent: a.sent + r.sent }), { total: 0, sent: 0 });
    console.log(`  all        ${t.total} emails: sent ${t.sent} (${pct(t.sent / t.total)})`);
  }
}
