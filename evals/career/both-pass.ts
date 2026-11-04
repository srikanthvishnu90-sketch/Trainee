// WO-061: the combined score. Each judge's verdict per item: the CI judges from the run's result file (each
// item's judges[]; a slot that errored is read from evals/career/results/<label>-rejudge-<model>.json when there is one),
// and Instinct, the owner-appointed second judge, from evals/career/instinct/<run>[-pN].json ({ "run", "pass_label",
// "items": [{ "id", "pass", "note" }] }). An item passes only when every judge that scored the run passes it; an item a
// judge did not score, or errored on, is not a pass. One line in SCORE-LOG.md per pass, with each judge's own count.
//   deno run -A evals/career/both-pass.ts evals/career/results/heldout-agent-<label>.json evals/career/instinct/<label>.json
const [resultFile, instinctFile] = Deno.args;
const r = JSON.parse(await Deno.readTextFile(resultFile));
const ins = JSON.parse(await Deno.readTextFile(instinctFile));
const err = (n?: string) => /^judge error/.test(n ?? "");
const verdicts: Record<string, Map<string, boolean | null>> = {};
// Judges that re-scored this run judge-only (rejudge.ts) count too, so every run carries the same judges.
const dir = resultFile.replace(/[^/]*$/, ""), base = resultFile.slice(dir.length).replace(/\.json$/, "");
const rejudged: string[] = [];
for await (const e of Deno.readDir(dir || ".")) { const m = e.name.match(new RegExp(`^${base}-rejudge-(.+)\\.json$`)); if (m) rejudged.push(m[1]); }
for (const m of [...new Set([r.judge_model, r.judge_model_2, ...rejudged].filter(Boolean))]) {
  let re: any = null;
  try { re = JSON.parse(await Deno.readTextFile(resultFile.replace(/\.json$/, `-rejudge-${m}.json`))); } catch { /* no re-score */ }
  const reBy = new Map<string, any>((re?.items ?? []).map((x: any) => [x.id, x]));
  verdicts[m] = new Map(r.items.map((x: any) => {
    const j = (x.judges ?? []).find((y: any) => y.model === m) ?? (m === r.judge_model && !x.judges ? { pass: x.pass, note: x.note } : null);
    const v = j && !err(j.note) ? !!j.pass : reBy.has(x.id) && !err(reBy.get(x.id).note) ? !!reBy.get(x.id).pass : null;
    return [x.id, v];
  }));
}
verdicts["Instinct"] = new Map((ins.items ?? []).map((x: any) => [String(x.id), x.pass === true]));
const ids: string[] = r.items.map((x: any) => x.id), total = ids.length;
const count = (m: string) => ids.filter((id) => verdicts[m].get(id) === true).length;
const unscored = (m: string) => ids.filter((id) => verdicts[m].get(id) == null).length;
const all = ids.filter((id) => Object.values(verdicts).every((v) => v.get(id) === true));
const judges = Object.keys(verdicts).map((m) => `${m} ${count(m)}${unscored(m) ? ` (${unscored(m)} unscored)` : ""}`).join(", ");
const label = ins.pass_label ?? r.label;
// Second judge's ruling (2026-10-21, in effect, reversible): H019-H026 are burned (heldout-burned.json); the clean items are scored apart, and the burned ones
// only as contaminated, never in the ratchet.
const burned = new Set<string>(JSON.parse(await Deno.readTextFile(new URL("./heldout-burned.json", import.meta.url))).items);
const cleanIds = ids.filter((id) => !burned.has(id)), cleanPass = all.filter((id) => !burned.has(id)).length;
const burnedPass = all.filter((id) => burned.has(id)).length;
const file = new URL("./SCORE-LOG.md", import.meta.url);
const log = await Deno.readTextFile(file).catch(() => "");
const at = new Date().toISOString().slice(0, 19).replace("T", " "), harness = r.harness ? `; harness: ${r.harness}` : "";
await Deno.writeTextFile(file, log + `| ${at} | ${r.source_commit ?? r.commit} | ${r.set}-clean | ${r.brain} | ${cleanIds.length} | ${cleanPass} | ${(cleanPass / cleanIds.length * 100).toFixed(1)}% | COMBINED on the clean ${cleanIds.length} (the ratchet's number), every judge passes: ${judges} (counts over all ${total}); burned ${burned.size}: ${burnedPass}/${burned.size}, CONTAMINATED | ${r.stopped ? "STOPPED" : "no"} | ${ins.run ?? ""} ${label}${harness} |\n`);
console.log(`${label}: combined clean ${cleanPass}/${cleanIds.length} (${(cleanPass / cleanIds.length * 100).toFixed(1)}%) · all ${all.length}/${total} · burned ${burnedPass}/${burned.size} (contaminated) · ${judges}`);
console.log(`not passed by every judge: ${ids.filter((id) => !all.includes(id)).map((id) => `${id}(${Object.keys(verdicts).map((m) => `${m.replace(/^[a-z]+-/, "")}${verdicts[m].get(id) === true ? "+" : verdicts[m].get(id) === false ? "-" : "?"}`).join(" ")})`).join(", ")}`);
