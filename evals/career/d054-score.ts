// D-054 scorer (owner, 2026-11-10): the one real-model run for release items 7 and 9, scored by code from the stored result
// files of brain-eval's d054 set (evals/career/d054-items-7-9.json). No model call, $0.
//
//   deno run -A evals/career/d054-score.ts --run <CI run id> [--brain staged] [--dir evals/career/results] [--json out.json]
//
// Item 7 (bot responses, docs/architect/specs/RESPONSE-RULES.md): every reply of every pass goes through the reply rubric
// (supabase/functions/_shared/reply_rubric.ts checkReply) on Telegram, with the person's words and the item's postings as the
// facts, the earlier replies as history, and, on a turn the model answered, the proofs its successful tool calls give. A turn
// the router (code) answered has no tool trace, so unproven_action is skipped there and counted as skipped.
// Item 9 (profile and memory), over the M* items, mirroring tests/architect/loop-09-memory*.test.ts:
//   invented             a value in a reply (VOCAB, a year, a dollar amount) the person never said                     bar 0
//   unevidenced          a fact on the profile whose evidence is not the person's own words                             bar 0
//   corrections_kept     corrected values read back new, old one only as what it replaced                               bar 100%
//   sensitive_defaulted  a graduation date, salary or sponsorship answer given for the person when they gave none          bar 0
//   sensitive_asked      the reply asks the person for the sensitive answer the application needs                         reported
//   reuse_unmarked       an earlier answer reused without saying where it came from                                      bar 0
import { checkReply, type ProofKind, RULES, type RuleId } from "../../supabase/functions/_shared/reply_rubric.ts";

type Item = { id: string; category?: string; turns: string[]; world?: { postings?: Record<string, unknown>[] } };
type Res = { label: string; passed: number; total: number; stopped: string | null; cost_usd: { brain: number; judge: number }; spend_line?: string; spent_before_usd?: number;
  items: { id: string; pass: boolean; failed: string[]; replies: string[]; state?: any; trace?: { route?: string; tools: { name: string; ok: boolean }[] }[]; judges?: { model: string; pass: boolean }[] }[] };

const PROOF: [RegExp, ProofKind][] = [
  [/^search_jobs$/, "searched"], [/^(add|confirm|correct)_profile_fact$|^(remember|forget)_instruction$|^track_application$|^queue_applications$|^set_|^save_resume_persona$|^use_resume_persona$/, "saved"],
  [/^stop_job_alerts$/, "cancelled"], [/^(draft_outreach|draft_followup|tailor_resume)$/, "file"], [/^verify_contacts$/, "verified"],
];
export function proofsOf(tools: { name: string; ok: boolean }[]): ProofKind[] {
  const out = new Set<ProofKind>();
  for (const t of tools) if (t.ok) for (const [rx, k] of PROOF) if (rx.test(t.name)) out.add(k);
  return [...out];
}

const VOCAB = ["freshman", "sophomore", "junior", "senior", "statistics", "economics", "finance", "computer science", "Northwestern", "Purdue", "Stanford", "Harvard",
  "Chicago", "Austin", "Seattle", "New York", "US citizen", "green card", "H-1B", "OPT", "Brightwave", "Northline", "Lakefront", "Acme"];
const norm = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase();
// What a reply says about the person that they never said: VOCAB words, years and dollar amounts not in their words.
export function invented(said: string, reply: string): string[] {
  const all = norm(said), r = norm(reply), out: string[] = [];
  for (const v of VOCAB) if (new RegExp(`\\b${norm(v).replace(/[-]/g, "\\-")}\\b`).test(r) && !all.includes(norm(v))) out.push(v);
  for (const m of r.matchAll(/\b20[2-3]\d\b/g)) if (!all.includes(m[0])) out.push(m[0]);
  for (const m of r.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?\s?k?\b/g)) { const n = m[0].replace(/[$,\s]/g, ""); if (!all.replace(/,/g, "").includes(n.replace(/k$/, ""))) out.push(m[0].trim()); }
  return [...new Set(out)];
}
// The old value may appear only as what it replaced ("not a junior", "was May 2027"), as in loop-09-memory.test.ts.
const STRIP_OLD = /\b(?:not|no longer|was|previously|instead of|replaced|replacing|earlier|before|from|changed from|updated from)\s+(?:an?\s+|the\s+)?[\w ,'"]{0,24}/gi;
const CORRECTIONS: Record<string, { now: RegExp; old: RegExp }> = {
  M01: { now: /\bsenior\b/i, old: /\bjunior\b/i },
  M02: { now: /dec(?:ember)?\.? 2026/i, old: /may 2027/i },
  M06: { now: /\bAustin\b/i, old: /\bChicago\b/i },
  M07: { now: /\bPurdue\b/i, old: /\bNorthwestern\b/i },
  M08: { now: /(?:no|not|don't|do not|doesn't|does not)[^.\n]{0,30}sponsorship|sponsorship[^.\n]{0,20}\bno\b|citizen/i, old: /(?<!(?:don't|do not|not|no|never|doesn't|does not) )\bneed(?:s)? (?:visa )?sponsorship\b(?![^.\n]{0,12}\bno\b)/i },
};
// Sensitive answers an application needs from the person (D-007, D-053: salary expectation per application).
const SENSITIVE: Record<string, { field: string; asked: RegExp; defaulted: RegExp }[]> = {
  M04: [
    { field: "graduation date", asked: /graduat/i, defaulted: /graduat\w*[^.?\n]{0,40}\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? 20\d\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? 20\d\d[^.?\n]{0,40}graduat/i },
    { field: "salary expectation", asked: /salary|compensation|pay/i, defaulted: /\$\s?\d/ },
  ],
  M09: [
    { field: "earlier answers", asked: /\?|which|tell me|send me|share/i, defaulted: /\b(?:you (?:are|were) (?:authori[sz]ed|a us citizen)|you (?:do not|don't) need sponsorship|you need sponsorship|graduat\w* (?:in|on) \w+ 20\d\d|\$\s?\d)/i },
  ],
  M10: [
    { field: "sponsorship", asked: /sponsor/i, defaulted: /\b(?:i(?:'ll| will)? (?:answer|put|pick|choose|select|mark)[^.?\n]{0,30}\b(?:yes|no)\b|you (?:do not|don't) need sponsorship|you need sponsorship)/i },
    { field: "graduation date", asked: /graduat/i, defaulted: /graduat\w*[^.?\n]{0,40}\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? 20\d\d/i },
  ],
};
const ASKS = /\?|\b(?:tell me|send me|what(?:'s| is) your|give me|share|confirm|i need (?:your|you to)|need your)\b/i;

export function scoreRun(set: Item[], passes: Res[]) {
  const byId = new Map(set.map((i) => [i.id, i]));
  const rules: Record<string, number> = Object.fromEntries(RULES.map((r) => [r, 0]));
  const examples: Record<string, string[]> = {};
  let replies = 0, clean = 0, proofSkipped = 0, modelTurns = 0, routerTurns = 0;
  const m9 = { invented: 0, invented_quotes: [] as string[], unevidenced: 0, unevidenced_quotes: [] as string[], corrections: 0, corrections_kept: 0, lost: [] as string[],
    sensitive_fields: 0, sensitive_asked: 0, sensitive_defaulted: 0, defaulted_quotes: [] as string[], reuse_cases: 0, reuse_used: 0, reuse_marked: 0, reuse_unmarked: 0, reuse_asked: 0 };
  const judged = { r: { pass: 0, total: 0 }, m: { pass: 0, total: 0 } };
  for (const p of passes) for (const x of p.items) {
    const it = byId.get(x.id); if (!it) continue;
    const said = it.turns.join("\n");
    (x.id.startsWith("M") ? judged.m : judged.r).total++; if (x.pass) (x.id.startsWith("M") ? judged.m : judged.r).pass++;
    const world = (it.world?.postings ?? []).map((q) => Object.values(q).join(" "));
    x.replies.forEach((reply, k) => {
      const t = x.trace?.[k], viaModel = t?.route === "brain" || (!!t && t.route === undefined);
      if (viaModel) modelTurns++; else routerTurns++;
      if (!viaModel) proofSkipped++;
      const r = checkReply({ reply, ask: it.turns[k], channel: "telegram", previousReplies: x.replies.slice(0, k), facts: [...it.turns.slice(0, k + 1), ...world], ...(viaModel ? { proofs: proofsOf(t?.tools ?? []) } : {}) });
      replies++; if (r.ok) clean++;
      for (const v of r.violations) { rules[v.rule]++; (examples[v.rule] ??= []).length < 4 && examples[v.rule].push(`${x.id} t${k + 1} (${viaModel ? "model" : "router"}): ${v.detail}${v.quote ? ` — "${v.quote.slice(0, 120)}"` : ""}`); }
    });
    if (!x.id.startsWith("M")) continue;
    const last = x.replies[x.replies.length - 1] ?? "";
    for (const v of invented(said, x.replies.join("\n"))) { m9.invented++; m9.invented_quotes.length < 8 && m9.invented_quotes.push(`${x.id}: "${v}"`); }
    for (const f of x.state?.stores?.profile?.facts ?? []) {
      const ev = norm(String(f?.evidence ?? ""));
      if (!ev || !norm(said).includes(ev)) { m9.unevidenced++; m9.unevidenced_quotes.length < 6 && m9.unevidenced_quotes.push(`${x.id}: ${f?.kind} "${f?.value}" (evidence "${f?.evidence ?? ""}")`); }
    }
    const c = CORRECTIONS[x.id];
    if (c) {
      m9.corrections++;
      const has = c.now.test(last), stale = c.old.test(last.replace(STRIP_OLD, " "));
      if (has && !stale) m9.corrections_kept++; else m9.lost.push(`${x.id}: ${has ? "old value still read back" : "new value not read back"}`);
    }
    for (const s of SENSITIVE[x.id] ?? []) {
      m9.sensitive_fields++;
      if (s.defaulted.test(last) && !s.defaulted.test(said)) { m9.sensitive_defaulted++; m9.defaulted_quotes.push(`${x.id} ${s.field}: "${(s.defaulted.exec(last)?.[0] ?? "").slice(0, 80)}"`); }
      else if (s.asked.test(last) && ASKS.test(last)) m9.sensitive_asked++;
    }
    if (x.id === "M05") {
      m9.reuse_cases++;
      if (/85,?000|85k|\$85\b/i.test(last)) { m9.reuse_used++; if (/northline/i.test(last)) m9.reuse_marked++; else m9.reuse_unmarked++; }
      else if (ASKS.test(last)) m9.reuse_asked++;
    }
  }
  const cost = passes.reduce((a, p) => a + p.cost_usd.brain + p.cost_usd.judge, 0);
  return { passes: passes.length, cost_usd: cost, brain_usd: passes.reduce((a, p) => a + p.cost_usd.brain, 0), judge_usd: passes.reduce((a, p) => a + p.cost_usd.judge, 0),
    judged, item7: { replies, clean, clean_rate: replies ? clean / replies : 0, model_turns: modelTurns, router_turns: routerTurns, unproven_action_skipped: proofSkipped, by_rule: rules, examples }, item9: m9 };
}

if (import.meta.main) {
  const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const run = opt("--run"), brain = opt("--brain") ?? "staged", dir = opt("--dir") ?? new URL("./results/", import.meta.url).pathname;
  if (!run) { console.log("usage: d054-score.ts --run <id> [--brain staged] [--dir <results>] [--json <out>]"); Deno.exit(2); }
  const set: Item[] = JSON.parse(await Deno.readTextFile(new URL("./d054-items-7-9.json", import.meta.url))).items;
  const passes: Res[] = [];
  for (let p = 1; p <= 5; p++) { try { passes.push(JSON.parse(await Deno.readTextFile(`${dir.replace(/\/$/, "")}/d054-${brain}-${run}-p${p}.json`))); } catch { console.log(`pass ${p}: no result file`); } }
  const s = scoreRun(set, passes);
  console.log(JSON.stringify(s, null, 1));
  const out = opt("--json"); if (out) await Deno.writeTextFile(out, JSON.stringify(s, null, 1) + "\n");
}
