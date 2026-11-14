// deno-lint-ignore-file no-explicit-any require-await
// Helpers for the group C amendments (owner decision 2026-11-13: the research support check is switched on). Nothing here says yes
// to a claim the page does not state: every judge below answers by the page text it is shown (support-test-judge.ts), and the draft
// lines below are sentences the synthetic pages themselves state.
import { supportJudgeAnswer, isSupportJudgeCall, testSupportJudge } from "./support-test-judge.ts";
export { testSupportJudge };

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

// For a test whose Anthropic stub scripts the brain's turns: the support judge's request goes to the same API. This wraps the stub's
// fetch so a request whose system prompt is the support judge's is answered here, by the page truth (supportJudgeAnswer), as the
// API's JSON message, and never reaches (or advances) the brain's script.
export function answerSupportJudge(inner: typeof fetch, seen: { judged: number } = { judged: 0 }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/api\.anthropic\.com/.test(url) && init?.body) {
      let body: any = null;
      try { body = JSON.parse(String(init.body)); } catch { /* not JSON */ }
      if (body && isSupportJudgeCall(body.system)) {
        seen.judged++;
        const user = body.messages?.[0]?.content;
        const text = supportJudgeAnswer(typeof user === "string" ? user : Array.isArray(user) ? String(user[0]?.text ?? "") : "");
        return new Response(JSON.stringify({ id: "msg_judge", type: "message", role: "assistant", model: body.model ?? "claude", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
}
