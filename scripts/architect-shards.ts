// CI sharding of the architect suite. `gate (architect)` ran `deno test` over every file in tests/architect serially in
// one job (1,323 s on a green run, cancelled at the 30-minute cap on others); the files are split across
// GATE_ARCHITECT_SHARD=i/n jobs. A file selected here is exactly a file `deno test tests/architect/` would discover, minus
// tests/architect/pending. Nothing is skipped or edited: tests/architect/ci-shard-partition.test.ts proves every file
// runs in exactly one shard.
//
// Balanced by measured duration (2026-10-30). The first split (2026-10-29) was by position in the sorted list
// (index % n): it needed no table, but the ~15 seeded scenario batteries landed unevenly (shards ran 354-651 s of tests
// on trunk a7178684c, shard 3 633 s on a PR) and every new file shifted every later file to another shard. Now each
// file has a measured duration in scripts/architect-shard-durations.json (the seconds of its tests inside a shard run,
// as `deno test` reports them), and the shards are packed longest first: the files in order of duration (longest
// first, then by name), each to the shard with the least time so far (ties to the lowest shard number). The same table
// and file list give the same shards on every machine. A file not in the table counts as `default_s`; a table entry for
// a file that no longer exists is an error in the test, so the table cannot rot silently. Each CI shard writes its
// files' durations as a notice ("architect file durations"); `update` merges them into the table.
//   deno run -A scripts/architect-shards.ts list <i> <n>         print shard i (1-based) of n, one path per line
//   deno run -A scripts/architect-shards.ts verify <n>           fail unless the n shards partition the whole suite
//   deno run -A scripts/architect-shards.ts plan <n>             each shard's file count and estimated seconds
//   deno run -A scripts/architect-shards.ts durations <log>...   seconds per file from `deno test` output (sum of its
//                                                                top-level tests), as JSON lines
//   deno run -A scripts/architect-shards.ts update <jsonl>...    merge those lines into the table (drops removed files)

const ROOT = new URL("../", import.meta.url);
// Deno's discovery rule: *_test.*, *.test.* or test.* with a script extension.
const TEST_FILE = /(^|[._])test\.(ts|tsx|mts|js|mjs|jsx)$/;

export type Durations = { default_s: number; files: Record<string, number> };

export function architectTestFiles(root: URL = ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of Deno.readDirSync(new URL(rel, root))) {
      const path = `${rel}${entry.name}`;
      if (entry.isDirectory) {
        if (path === "tests/architect/pending") continue;
        walk(`${path}/`);
      } else if (entry.isFile && TEST_FILE.test(entry.name)) out.push(path);
    }
  };
  walk("tests/architect/");
  return out.sort();
}

export function loadDurations(root: URL = ROOT): Durations {
  const raw = JSON.parse(Deno.readTextFileSync(new URL("scripts/architect-shard-durations.json", root)));
  const files: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.files ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`bad duration for ${k}: ${v}`);
    files[k] = v;
  }
  const d = Number(raw.default_s);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad default_s: ${raw.default_s}`);
  return { default_s: d, files };
}

export const durationOf = (file: string, d: Durations) => d.files[file] ?? d.default_s;

// Longest-processing-time-first packing. Deterministic: the order is (duration desc, path asc), and a tie between shards
// goes to the lowest-numbered one.
export function assignShards(files: string[], count: number, d: Durations): { files: string[]; seconds: number }[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad shard count ${count}`);
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  const order = [...new Set(files)].sort((a, b) => durationOf(b, d) - durationOf(a, d) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < count; i++) if (shards[i].seconds < shards[best].seconds) best = i;
    shards[best].files.push(f);
    shards[best].seconds += durationOf(f, d);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

export function shardOf(files: string[], shard: number, count: number, d: Durations = loadDurations()): string[] {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(shard) || shard < 1 || shard > count) {
    throw new Error(`bad shard ${shard}/${count}`);
  }
  return assignShards(files, count, d)[shard - 1].files;
}

// Seconds per file from `deno test` output: the sum of each file's top-level tests (steps are indented and inside them).
export function parseDenoDurations(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let file: string | null = null;
  const unit = (s: string) => {
    let t = 0;
    for (const m of s.matchAll(/([\d.]+)(µs|ms|s|m|h)(?![a-zµ])/g)) {
      const n = Number(m[1]);
      t += m[2] === "µs" ? n / 1e6 : m[2] === "ms" ? n / 1e3 : m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
    }
    return t;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r$/, "");
    const run = line.match(/^running \d+ tests? from \.\/(\S+)$/);
    if (run) { file = run[1]; out[file] ??= 0; continue; }
    const t = line.match(/^\S.* \.\.\. (?:ok|FAILED|ignored|cancelled) \(([^)]+)\)$/);
    if (t && file) out[file] += unit(t[1]);
  }
  return out;
}

if (import.meta.main) {
  const [cmd, a, b] = Deno.args;
  if (cmd === "durations") {
    const all: Record<string, number> = {};
    for (const p of Deno.args.slice(1)) for (const [k, v] of Object.entries(parseDenoDurations(Deno.readTextFileSync(p)))) all[k] = (all[k] ?? 0) + v;
    for (const k of Object.keys(all).sort()) console.log(JSON.stringify({ file: k, seconds: Math.round(all[k] * 10) / 10 }));
    Deno.exit(0);
  }
  if (cmd === "update") {
    // Merge `durations` output (JSON lines, e.g. from each CI shard's "architect file durations" notice) into the table;
    // entries for files no longer in the suite are dropped.
    const path = new URL("scripts/architect-shard-durations.json", ROOT);
    const table = JSON.parse(Deno.readTextFileSync(path));
    const suite = new Set(architectTestFiles());
    for (const p of Deno.args.slice(1)) {
      for (const line of Deno.readTextFileSync(p).split("\n")) {
        const m = line.match(/\{.*\}/);
        if (!m) continue;
        const { file, seconds } = JSON.parse(m[0]);
        if (typeof file === "string" && typeof seconds === "number" && Number.isFinite(seconds)) table.files[file] = Math.max(0.1, Math.round(seconds * 10) / 10);
      }
    }
    table.files = Object.fromEntries(Object.keys(table.files).filter((f) => suite.has(f)).sort().map((f) => [f, table.files[f]]));
    Deno.writeTextFileSync(path, JSON.stringify(table, null, 2) + "\n");
    console.log(`${Object.keys(table.files).length} files in the table`);
    Deno.exit(0);
  }
  const files = architectTestFiles();
  if (cmd === "list") {
    const picked = shardOf(files, Number(a), Number(b));
    if (!picked.length) throw new Error(`shard ${a}/${b} is empty`);
    console.log(picked.join("\n"));
  } else if (cmd === "verify") {
    const count = Number(a);
    const seen = new Map<string, number>();
    for (let s = 1; s <= count; s++) for (const f of shardOf(files, s, count)) seen.set(f, (seen.get(f) ?? 0) + 1);
    const bad = files.filter((f) => seen.get(f) !== 1);
    if (!files.length || bad.length || seen.size !== files.length) {
      console.error(`shards do not partition the suite: ${bad.join(", ") || "no files"}`);
      Deno.exit(1);
    }
    console.log(`${files.length} architect test files, each in exactly one of ${count} shards`);
  } else if (cmd === "plan") {
    const d = loadDurations();
    const shards = assignShards(files, Number(a), d);
    const mean = shards.reduce((s, x) => s + x.seconds, 0) / shards.length;
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${shards.length}: ${s.files.length} files, ~${s.seconds.toFixed(0)} s (${(s.seconds / mean).toFixed(2)}x mean)`));
    const missing = files.filter((f) => !(f in d.files));
    if (missing.length) console.log(`not in the table (counted as ${d.default_s} s): ${missing.join(", ")}`);
  } else {
    console.error("usage: architect-shards.ts list <i> <n> | verify <n> | plan <n> | durations <deno test log>... | update <jsonl>...");
    Deno.exit(2);
  }
}
