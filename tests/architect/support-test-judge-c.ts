// deno-lint-ignore-file no-explicit-any require-await
// Helpers for the group C amendments (owner decision 2026-11-13: the research support check is switched on). Nothing here says yes
// to a claim the page does not state: every judge below answers by the page text it is shown (support-test-judge.ts), and the draft
// lines below are sentences the synthetic pages themselves state.
import { bare, type SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { isSupportJudgeCall, supportsClaim, testSupportJudge } from "./support-test-judge.ts";
export { testSupportJudge };

// support-test-judge.ts says yes to every quote check ("The marked text "…" is the page's own statement of fact …, and it answers
// the question: …"). The real judge is asked whether the unit answers the question, and says no to a page sentence that has nothing
// to do with it (a tariff review for "the outlook for hydrogen trucks"). This judge answers that part by the page too: a quote check
// is yes only when the marked text shares a content word with the question (the person's own words, not code's). Model-worded
// claims are judged exactly as support-test-judge.ts judges them.
const STOP = new Set("a an the and or of to in on at for by with from as is are was were be been it its this that what which who how why when where do does did will would could should can me my i you your we our they their there these those give tell show find get about any some much many more most give research compare file".split(" "));
const stem = (w: string) => w.replace(/(?:ies|es|s|ed|ing)$/, "");
const wordsOf = (t: string) => new Set((bare(t).toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map((w) => w.replace(/['’]s$/, "")).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
const QUOTE_CHECK = /^The marked text "([\s\S]*)" is the page's own statement of fact[\s\S]*?(?:, and it answers the question: ([\s\S]*?))?\.?$/;
export function answersAsk(claim: string, source: string): boolean {
  const q = QUOTE_CHECK.exec(claim);
  if (!q) return supportsClaim(claim, source);
  if (!q[2]) return true;
  const have = wordsOf(q[1]);
  return [...wordsOf(q[2])].some((w) => have.has(w));
}
export const askAwareJudge: SupportJudge = async (cs) => cs.map((c) => answersAsk(c.claim, c.source) ? "yes" : "no");

// The synthetic Greenhouse board's own lines (tests/helpers/research_free_web.ts, GH_JOBS, as the free reader writes them). With the
// check on, a brief's "what would have to be true" and "risks" lines stand only when a page states them; the free web's company
// pages carry no such sentence, so a File test drafts these, which the board states.
export const BOARD = "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs";
export const BOARD_CONDITION = "Open role on the Greenhouse job board with the token zentrafin: Software Engineer, New Grad, New York, NY.";
export const BOARD_RISK = "The board does not name its company.";

// A judge that also records what it was asked (claims and verdicts), for a test that must show what was refused.
export function recordingJudge() {
  const asked: { claim: string; verdict: "yes" | "no" }[] = [];
  const judge = async (cs: { claim: string; source: string }[]) => {
    const out = await testSupportJudge(cs);
    cs.forEach((c, k) => asked.push({ claim: c.claim, verdict: out[k] }));
    return out;
  };
  return { judge, asked };
}

// For a test whose Anthropic stub scripts the brain's turns: the support judge's request goes to the same API. A request whose system
// prompt is the support judge's is answered here, by the page truth (answersAsk), as the API's JSON message, so it never reaches
// (or advances) the brain's script. judgeResponse(body) is that answer, or null for any other request; answerSupportJudge wraps a
// stub's fetch with it.
export function judgeResponse(body: any): Response | null {
  if (!body || !isSupportJudgeCall(body.system)) return null;
  const user = body.messages?.[0]?.content;
  let items: { claim: string; source: string }[] = [];
  try { items = JSON.parse(typeof user === "string" ? user : Array.isArray(user) ? String(user[0]?.text ?? "") : ""); } catch { /* empty */ }
  const text = JSON.stringify(items.map((x) => answersAsk(String(x.claim ?? ""), String(x.source ?? "")) ? "yes" : "no"));
  return Response.json({ id: "msg_judge", type: "message", role: "assistant", model: body.model ?? "claude", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
}
export function answerSupportJudge(inner: typeof fetch, seen: { judged: number } = { judged: 0 }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/api\.anthropic\.com/.test(url)) {
      let body: any = null;
      try { body = input instanceof Request && !init ? await input.clone().json() : JSON.parse(String(init?.body ?? "")); } catch { /* not JSON */ }
      const r = judgeResponse(body);
      if (r) { seen.judged++; return r; }
    }
    return inner(input, init);
  }) as typeof fetch;
}

// For a harness that answers every no-tools model call through a hook given (system, user) (tests/architect/helpers/mirror_process.ts
// runConversation's `draft`): the support judge's answer by the page truth, or null for any other call.
export function judgeDraft(system: string, user: string): string | null {
  if (!isSupportJudgeCall(system)) return null;
  let items: { claim: string; source: string }[] = [];
  try { items = JSON.parse(user); } catch { /* empty */ }
  return JSON.stringify(items.map((x) => answersAsk(String(x.claim ?? ""), String(x.source ?? "")) ? "yes" : "no"));
}
