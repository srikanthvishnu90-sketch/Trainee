// Regression (CI of #447: missing-info 8b, flow-mass-apply-telegram): `deno test` runs a shard's files in one process, so a test file that
// sets a model key and leaves it set lets a later file's chat turn reach the model. Every file that sets ANTHROPIC_API_KEY on the
// process environment must also restore or delete it.
import assertNode from "node:assert/strict";

Deno.test("a test file that sets ANTHROPIC_API_KEY on the process env also restores it", async () => {
  const bad: string[] = [];
  for await (const e of Deno.readDir(new URL("./", import.meta.url))) {
    if (!e.isFile || !/\.test\.ts$/.test(e.name) || e.name === "test-env-hygiene.test.ts") continue;
    const text = await Deno.readTextFile(new URL(`./${e.name}`, import.meta.url));
    const sets = /Deno\.env\.set\(\s*["']ANTHROPIC_API_KEY["']/.test(text) || /Deno\.env\.set\(k, v\)[^\n]*\n[^\n]*ANTHROPIC_API_KEY/.test(text);
    if (!sets) continue;
    const restores = /Deno\.env\.delete\(\s*["']ANTHROPIC_API_KEY["']/.test(text) || /priorKey/.test(text) || /\[[^\]]*"ANTHROPIC_API_KEY"[^\]]*\]/.test(text) || /Object\.keys\(env\)|Object\.entries\(saved\)/.test(text);
    if (!restores) bad.push(e.name);
  }
  assertNode.deepEqual(bad, [], `these files leave ANTHROPIC_API_KEY set for later files: ${bad.join(", ")}`);
});
