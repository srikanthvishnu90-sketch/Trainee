// A deterministic stand-in for the research support judge (research/support.ts layer B), for tests written before the check was
// switched on (owner decision 2026-11-13). It is not an always-yes judge:
//   - a quote check ("The marked text "…" is the page's own statement …") is yes: code has already chosen the page's own unit;
//   - a claim in the model's words is yes only when every content word of it is in the marked text (with its whole sentence and the
//     table header the passage shows) and the claim and the marked text agree on negation.
// Layer A (code) still runs before it, so a figure, name or year the page does not give never reaches it.
import { bare, type SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";

const STOP = new Set("a an the and or of to in on at for by with from as is are was were be been it its this that these those their there they them he she his her we our you your i my me than then so such per each every any all some about into over under after before also only just very more most less least can could will would should may might must do does did has have had not no never".split(" "));
const NEG = /(?<![\p{L}])(?:not|no|never|none|neither|nor|without)(?![\p{L}])|n['’]t(?![\p{L}])/giu;
const words = (t: string) => new Set((bare(t).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}$%.,'’-]*/gu) ?? []).map((w) => w.replace(/[.,'’-]+$/, "").replace(/'s$/, "")).filter((w) => w && !STOP.has(w)));
const stem = (w: string) => w.replace(/(?:ies|es|s|ed|ing)$/, "");
const negs = (t: string) => (t.match(NEG) ?? []).length % 2;

export function supportsClaim(claim: string, source: string): boolean {
  if (/^The marked text "/.test(claim)) return true;
  const marked = /^>>> (.*) <<<$/m.exec(source)?.[1] ?? "";
  const whole = /^Its whole sentence: (.*)$/m.exec(source)?.[1] ?? "";
  const header = /^Table header: (.*)$/m.exec(source)?.[1] ?? "";
  const pageOf = /^Page of: ([^(]+)/m.exec(source)?.[1] ?? "";
  const title = /^Page title: (.*)$/m.exec(source)?.[1] ?? "";
  const have = new Set([...words(`${marked} ${whole} ${header} ${pageOf} ${title}`)].map(stem));
  if (negs(claim) !== negs(whole || marked)) return false;
  return [...words(claim)].every((w) => have.has(stem(w)));
}
export const testSupportJudge: SupportJudge = async (cs) => cs.map((c) => supportsClaim(c.claim, c.source) ? "yes" : "no");
// The judge's call as it reaches the model API (a request whose system prompt is the support judge's): its JSON answer.
export const isSupportJudgeCall = (system: unknown) => /^You check claims against passages/.test(typeof system === "string" ? system : Array.isArray(system) ? String(system[0]?.text ?? "") : "");
export function supportJudgeAnswer(userContent: string): string {
  let items: { claim: string; source: string }[] = [];
  try { items = JSON.parse(userContent); } catch { /* empty */ }
  return JSON.stringify(items.map((x) => supportsClaim(String(x.claim ?? ""), String(x.source ?? "")) ? "yes" : "no"));
}
