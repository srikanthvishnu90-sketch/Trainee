// S3 residual (H021, H025). Offline. deno test -A --no-check tests/architect/brain-s3-residual-20261106.test.ts
import assertNode from "node:assert/strict";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";

const p = careerSystemPrompt("2026-11-06");
const rule = (start: RegExp) => {
  const i = p.search(start);
  assertNode.ok(i >= 0, `rule not found: ${start}`);
  const rest = p.slice(i + 1);
  const j = rest.search(/\n- /);
  return p.slice(i, j < 0 ? undefined : i + 1 + j);
};

Deno.test("S3-1: the nothing-sent rule does not mention overwhelmed; the acknowledgement comes first", () => {
  const r = rule(/When the\s+message is about acting on jobs/);
  assertNode.ok(!/overwhelmed/.test(r.split("When they say they are overwhelmed")[0]), "overwhelmed in trigger list");
  assertNode.ok(/acknowledgement rule below comes\s+first/.test(r));
});

Deno.test("S3-2: with no resume on file, no gaps are listed", () => {
  const r = rule(/With no resume on file/);
  assertNode.ok(/List NO gaps/.test(r));
  assertNode.ok(!/common gaps/.test(p));
  assertNode.ok(/live postings/.test(r));
});

Deno.test("S3-3: the overwhelmed rule forbids explaining missing profile items", () => {
  const r = rule(/They say they are overwhelmed/);
  assertNode.ok(/Never explain what is missing from their profile/.test(r));
  assertNode.ok(/list role types/.test(r));
});
