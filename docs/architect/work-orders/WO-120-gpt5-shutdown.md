# WO-120: off the gpt-5 family before OpenAI shuts it down (D-038)

**Owner:** the architect (Claude). **Deadline: 2026-12-01** (ten days before the shutdown, for a measured switch and a
rollback window). **Assignee:** architect. **Depends on:** #408 (D-038).

## Why
OpenAI shuts down `gpt-5`, `gpt-5-mini` and `gpt-5-nano` on **2026-12-11**, and `gpt-4.1-mini` on **2027-01-14**
(developers.openai.com/api/docs/deprecations.md, read 2026-11-01). After that date every call to them fails. The product
answers with the outage sentence, and the eval cannot score. Today these readers use them:

| Reader | Where | Model today |
|---|---|---|
| Router, flow router, planner, finance chat | `_shared/model_gateway.ts` `OPENAI_DEFAULT_MODEL` | gpt-5-nano |
| Career reply model | `agent-chat/release_model.ts` `CAREER_MODEL_DEFAULT` | gpt-5-mini (D-038 candidate: claude-haiku-5-5) |
| Mail second opinion | `_shared/career_mail_model.ts` `mailModelConfig` | `openaiCareerModel` → gpt-5-mini |
| Essay drafts | `_shared/career_essay_card.ts` `essayModelConfig` | `openaiCareerModel` → gateway default |
| Mock-prep judge | `_shared/career_mock_prep.ts` `modelJudge` | `openaiCareerModel` → gpt-5-mini |
| Outreach replies lane | `career-proactive/index.ts` | `openaiCareerModel` → gpt-5-mini |
| Eval judge 1 | `brain-eval.yml` `EVAL_JUDGE_MODEL` | gpt-5-mini |
| Eval judge 2 | `brain-eval.yml` `EVAL_JUDGE_MODEL_2` | gpt-4.1-mini (2027-01-14) |

## What
1. **Gateway first.** `toOpenAI` sends `reasoning_effort` only to `gpt-5*`/`o*` ids. A `gpt-6*` id gets no effort, so it
   runs at its default (`medium`), and at that effort gpt-6-sol and gpt-6-luna refuse function calling on Chat Completions.
   Teach `reasoningModel` the gpt-5.6/gpt-6 families, and send `none` where `minimal` was configured: `minimal` is not a
   GPT-6 value, and `none` is the only effort at which those two models call tools on Chat Completions. gpt-6-astra,
   gpt-6.1-sol and gpt-6.1-terra need the Responses API for tools: they stay off the tool paths unless the gateway gains a
   Responses tool path, which would be a separate order.
2. **Price rows**, read on the provider's page with the date, for every model chosen (gpt-6-luna: $0.10 in / $0.01
   cached / $0.50 out, page read 2026-11-01).
3. **Readers.** Router: `OPENAI_DEFAULT_MODEL` → gpt-6-luna (effort `none`). The four `openaiCareerModel` readers: their
   fallback → gpt-6-luna. Reply model: per D-038's measurement (Haiku or Sonnet if they pass; otherwise gpt-6-luna,
   measured the same way).
4. **Judges.** Run one S3 dev measurement of the deployed SHA with old and new judges on the same five passes. New
   judges: judge 1 gpt-6-luna, judge 2 a different family (claude-haiku-5-5 via the gateway, if the owner keeps the
   Anthropic key; else gpt-6.1-terra over Responses). Record both scores in SCORE-LOG, then switch. S3 compares like with
   like: a SHA measured under the old judges is re-measured under the new ones before the first comparison.

## Acceptance tests (write first, in `tests/architect/pending/wo-120-*.test.ts`)
- A source scan finds no `gpt-5`, `gpt-5-mini`, `gpt-5-nano` or `gpt-4.1-mini` model id in production code or
  `brain-eval.yml` (comments and price rows excepted).
- `toOpenAI` for `gpt-6-luna` with tools sends `reasoning_effort: "none"`, no temperature, and `max_completion_tokens`.
- Every default model has a verified price row dated after 2026-10-31.
- The judge switch run is in SCORE-LOG with both judge sets on the same passes.

## Demo
`deno run -A evals/career/run.ts --brain staged --set dev --label wo120-demo` on the new defaults, plus one live turn on
the test account after deploy (owner's deploy).

## Out of scope
Voice models (D-voice is off). The Responses API tool path.

## Size cap
About 300 lines of code plus tests. The judge re-baseline costs about $0.25 of OpenAI.
