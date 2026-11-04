#!/usr/bin/env node
"use strict";
// CI sharding of gate (core)'s node suites (2026-10-30). gate (core) was the longest job of every ci run: one
// `node --test --test-concurrency=2` over ~250 career and shared suites, 638-730 s of that step plus ~45 s of edge
// tests, typechecks and the bundle check (runs 41112398301-41143560374, job median 785 s, the whole run's wall time).
// The suites are split across GATE_CORE_SHARD=i/n jobs exactly as the architect suite is (scripts/architect-shards.ts):
// packed longest first by measured seconds, each file to the least-loaded shard, ties to the lowest shard number. The
// same command, flags and concurrency run in every shard; only the file list is a slice. Nothing is skipped or edited:
// `verify` (run in every shard and in the aggregate gate (core) job) fails unless the shards partition the list exactly,
// and tests/career-ci-core-shards.test.cjs proves it for the gate's real selection.
//
// The table is scripts/core-shard-durations.json: {default_s, reserve_s, files}. A file not in the table counts as
// default_s; reserve_s is shard 1's head start for the non-node core steps it alone runs (edge tests, pay importers,
// bundle check, typecheck). Each shard writes its files' seconds (scripts/node-test-durations.mjs) as a notice;
// `update` merges them in.
//   node scripts/node-shards.cjs list <i> <n> <file>...     print shard i (1-based) of n of the given files
//   node scripts/node-shards.cjs verify <n> <file>...       fail unless the n shards partition the files exactly
//   node scripts/node-shards.cjs plan <n> <file>...         each shard's file count and estimated seconds
//   node scripts/node-shards.cjs update <jsonl>...          merge {"file","seconds"} lines into the table
const fs = require("node:fs");
const path = require("node:path");

const TABLE = path.join(__dirname, "core-shard-durations.json");

function loadTable(file = TABLE) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const d = Number(raw.default_s), r = Number(raw.reserve_s ?? 0);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad default_s: ${raw.default_s}`);
  if (!Number.isFinite(r) || r < 0) throw new Error(`bad reserve_s: ${raw.reserve_s}`);
  const files = {};
  for (const [k, v] of Object.entries(raw.files || {})) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`bad duration for ${k}: ${v}`);
    files[k] = v;
  }
  return { default_s: d, reserve_s: r, files };
}

const durationOf = (f, t) => (Object.prototype.hasOwnProperty.call(t.files, f) ? t.files[f] : t.default_s);

function assignShards(files, count, t) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad shard count ${count}`);
  const shards = Array.from({ length: count }, (_, i) => ({ files: [], seconds: i === 0 ? t.reserve_s : 0 }));
  const order = [...new Set(files)].sort((a, b) => durationOf(b, t) - durationOf(a, t) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < count; i++) if (shards[i].seconds < shards[best].seconds) best = i;
    shards[best].files.push(f);
    shards[best].seconds += durationOf(f, t);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

function shardOf(files, shard, count, t = loadTable()) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(shard) || shard < 1 || shard > count) {
    throw new Error(`bad shard ${shard}/${count}`);
  }
  return assignShards(files, count, t)[shard - 1].files;
}

function verify(files, count, t = loadTable()) {
  const seen = new Map();
  for (let s = 1; s <= count; s++) {
    const picked = shardOf(files, s, count, t);
    if (!picked.length) throw new Error(`shard ${s}/${count} is empty`);
    for (const f of picked) seen.set(f, (seen.get(f) || 0) + 1);
  }
  const unique = [...new Set(files)];
  const bad = unique.filter((f) => seen.get(f) !== 1);
  if (!unique.length || bad.length || seen.size !== unique.length) {
    throw new Error(`the ${count} shards do not partition the ${unique.length} files: ${bad.join(", ") || "no files"}`);
  }
  return unique.length;
}

module.exports = { loadTable, durationOf, assignShards, shardOf, verify, TABLE };

if (require.main === module) {
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "list") {
      console.log(shardOf(rest, Number(a), Number(b)).join("\n"));
    } else if (cmd === "verify") {
      const files = [b, ...rest].filter(Boolean);
      console.log(`${verify(files, Number(a))} core node suites, each in exactly one of ${a} shards`);
    } else if (cmd === "plan") {
      const t = loadTable(), files = [b, ...rest].filter(Boolean);
      const shards = assignShards(files, Number(a), t);
      shards.forEach((s, i) => console.log(`core shard ${i + 1}/${shards.length}: ${s.files.length} files, ~${s.seconds.toFixed(0)} s`));
      const missing = files.filter((f) => !(f in t.files));
      if (missing.length) console.log(`${missing.length} not in the table (counted as ${t.default_s} s each)${missing.length <= 10 ? `: ${missing.join(", ")}` : ""}`);
    } else if (cmd === "update") {
      // Merges measured seconds in place: existing keys keep their position (so a concurrent branch that appends a
      // file merges cleanly), new files are appended. Entries for files that no longer exist are dropped.
      const raw = JSON.parse(fs.readFileSync(TABLE, "utf8"));
      for (const p of [a, b, ...rest].filter(Boolean)) {
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          const m = line.match(/\{.*\}/);
          if (!m) continue;
          let o;
          try { o = JSON.parse(m[0]); } catch { continue; }
          if (typeof o.file === "string" && typeof o.seconds === "number" && Number.isFinite(o.seconds)) {
            raw.files[o.file] = Math.max(0.1, Math.round(o.seconds * 10) / 10);
          }
        }
      }
      raw.files = Object.fromEntries(Object.entries(raw.files).filter(([f]) => fs.existsSync(path.join(__dirname, "..", f))));
      fs.writeFileSync(TABLE, JSON.stringify(raw, null, 2) + "\n");
      console.log(`${Object.keys(raw.files).length} files in the table`);
    } else {
      console.error("usage: node-shards.cjs list <i> <n> <file>... | verify <n> <file>... | plan <n> <file>... | update <jsonl>...");
      process.exit(2);
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
}
