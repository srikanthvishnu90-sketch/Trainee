// A node:test reporter (an extra one: the gate keeps TAP on stdout) that writes each test file's seconds as JSON lines,
// {"file":"tests/x.test.cjs","seconds":12.3}, for the gate (core) shard table (scripts/node-shards.cjs). A file's seconds
// are the sum of its top-level tests' and suites' durations. (The runner reports files in order, holding a later file's
// events until the earlier ones are out, so the time an event arrives says nothing about its file; a file-level
// before/after hook is not counted.) Observation only: a reporter cannot change a test's outcome or the run's exit code,
// and nothing reads these numbers to decide a verdict.
import path from "node:path";

export default async function* durations(source) {
  const files = new Map();
  const cwd = process.cwd();
  for await (const event of source) {
    const data = event.data || {};
    if (!data.file) continue;
    const rel = path.relative(cwd, data.file).split(path.sep).join("/");
    if (!files.has(rel)) files.set(rel, 0);
    if ((event.type === "test:pass" || event.type === "test:fail") && data.nesting === 0) {
      files.set(rel, files.get(rel) + (Number(data.details?.duration_ms) || 0));
    }
  }
  for (const [file, ms] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    yield JSON.stringify({ file, seconds: Math.round(ms / 100) / 10 }) + "\n";
  }
}
