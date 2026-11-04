// Every architect test file (pending excluded) runs in exactly one `gate (architect)` shard, the shard count in the
// workflow matches the one the gate script is told to use, and the shards are balanced by the measured duration table
// (scripts/architect-shard-durations.json): no shard over 1.3x the mean, the same assignment every time.
import { architectTestFiles, assignShards, durationOf, loadDurations, parseDenoDurations, shardOf } from "../../scripts/architect-shards.ts";

const COUNT = 6;
const BALANCE = 1.3;

Deno.test("the architect shards partition tests/architect exactly", () => {
  const files = architectTestFiles();
  if (files.length < 100) throw new Error(`suspiciously few architect test files: ${files.length}`);
  if (files.some((f) => f.includes("/pending/"))) throw new Error("pending file selected");
  const counts = new Map<string, number>();
  for (let s = 1; s <= COUNT; s++) {
    const shard = shardOf(files, s, COUNT);
    if (!shard.length) throw new Error(`shard ${s} is empty`);
    for (const f of shard) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const f of files) if (counts.get(f) !== 1) throw new Error(`${f} ran in ${counts.get(f) ?? 0} shards`);
  if (counts.size !== files.length) throw new Error("a shard selected a file outside the suite");
});

Deno.test("this file is itself in the suite, and the workflow matrix has COUNT shards", async () => {
  if (!architectTestFiles().includes("tests/architect/ci-shard-partition.test.ts")) throw new Error("not discovered");
  const yml = await Deno.readTextFile(new URL("../../.github/workflows/ci.yml", import.meta.url));
  const m = yml.match(/GATE_ARCHITECT_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/);
  if (!m || Number(m[1]) !== COUNT) throw new Error(`ci.yml shard count ${m?.[1]} != ${COUNT}`);
  const matrix = yml.match(/gate-architect-shard:[\s\S]*?shard: \[([\d, ]+)\]/);
  if (!matrix || matrix[1].split(",").map(Number).join() !== Array.from({ length: COUNT }, (_, i) => i + 1).join()) {
    throw new Error("ci.yml matrix is not 1..COUNT");
  }
  const verify = yml.match(/architect-shards\.ts verify (\d+)/);
  if (!verify || Number(verify[1]) !== COUNT) throw new Error(`ci.yml verifies ${verify?.[1]} shards, not ${COUNT}`);
});

Deno.test("the duration table names only files in the suite, and every duration is a measured number", () => {
  const files = new Set(architectTestFiles()), d = loadDurations();
  const stale = Object.keys(d.files).filter((f) => !files.has(f));
  if (stale.length) throw new Error(`scripts/architect-shard-durations.json names files not in the suite (renamed or removed?): ${stale.join(", ")}`);
  if (Object.keys(d.files).length < files.size * 0.9) throw new Error(`the table covers only ${Object.keys(d.files).length} of ${files.size} files: re-measure`);
});

Deno.test(`the shards are balanced by measured duration: none over ${BALANCE}x the mean, and the assignment is deterministic`, () => {
  const files = architectTestFiles(), d = loadDurations();
  const shards = assignShards(files, COUNT, d);
  const mean = shards.reduce((s, x) => s + x.seconds, 0) / COUNT;
  const report = shards.map((s, i) => `${i + 1}: ${s.seconds.toFixed(0)} s`).join(", ");
  for (const s of shards) if (s.seconds > BALANCE * mean) throw new Error(`a shard is over ${BALANCE}x the mean (${mean.toFixed(0)} s): ${report}`);
  // The same answer from any order of the same files (the gate lists them sorted; nothing depends on the walk's order).
  const again = assignShards([...files].reverse(), COUNT, d);
  if (JSON.stringify(again.map((s) => s.files)) !== JSON.stringify(shards.map((s) => s.files))) throw new Error("the assignment depends on input order");
  // No single file is so long that it alone breaks the balance (split such a battery into parts instead).
  const longest = Math.max(...files.map((f) => durationOf(f, d)));
  if (longest > BALANCE * mean) throw new Error(`one file takes ${longest} s, over ${BALANCE}x the mean shard`);
});

Deno.test("packing units: longest first to the least-loaded shard, ties to the lowest; unknown files count as the default", () => {
  const d = { default_s: 5, files: { "a": 10, "b": 9, "c": 8, "d": 2, "e": 1 } };
  const s = assignShards(["e", "d", "c", "b", "a", "x"], 3, d);
  const got = JSON.stringify(s.map((x) => [x.files, x.seconds]));
  // a(10)->1, b(9)->2, c(8)->3, x(5, default)->3 (13), d(2)->2 (11), e(1)->1 (11)
  if (got !== JSON.stringify([[["a", "e"], 11], [["b", "d"], 11], [["c", "x"], 13]])) throw new Error(got);
  let threw = false;
  try { shardOf(["a"], 0, 3, d); } catch { threw = true; }
  if (!threw) throw new Error("shard 0 accepted");
});

Deno.test("durations from deno test output: each file's top-level tests summed; steps (indented) not counted twice", () => {
  const log = [
    "\x1b[0m\x1b[38;5;245mrunning 2 tests from ./tests/architect/a.test.ts\x1b[0m",
    "one ... \x1b[0m\x1b[32mok\x1b[0m \x1b[0m\x1b[38;5;245m(1s)\x1b[0m",
    "  step ... ok (900ms)",
    "two ... FAILED (1m 2s)",
    "running 1 test from ./tests/architect/b.test.ts",
    "three ... ok (250ms)",
    "four ... ok (517µs)",
    "running 1 test from ./tests/architect/c.test.ts",
    "five ... ok (2m29s)",
  ].join("\n");
  const got = parseDenoDurations(log);
  if (Math.abs(got["tests/architect/a.test.ts"] - 63) > 1e-9 || Math.abs(got["tests/architect/b.test.ts"] - 0.250517) > 1e-9 || got["tests/architect/c.test.ts"] !== 149) throw new Error(JSON.stringify(got));
});
