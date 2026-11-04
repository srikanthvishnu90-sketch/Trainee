// MUSE-F-011 (live on v246, 2026-10-21): a tailor turn whose render threw "ReferenceError: Buffer is not defined". Module
// 148 read the bare Node Buffer global, which the Deno edge runtime (2.1.4) does not have; module 143's containment
// served "Something went wrong on my end". Each fixture replays through the STAGED career bundle in a child Deno process
// whose realm has the Buffer global REMOVED before import (tests/edge/lib/career-replay-child.ts): the local Deno's own
// Buffer global would mask the defect in-process. A replay passes only when the turn lands on career_tailor, uncontained,
// with a real PDF artifact. (This was the career_tailor kind of the finance-era live-replays test, removed 2026-10-28.)
import DB from "./lib/fixtures/career-tailor-replays.json" with { type: "json" };
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }

assert(Array.isArray((DB as any).fixtures) && (DB as any).fixtures.length > 0, "the replay file holds fixtures");
for (const f of (DB as any).fixtures as any[]) {
  Deno.test(`career tailor in the Buffer-free realm ${f.id} ${JSON.stringify(f.text)}`, async () => {
    const child = new URL("./lib/career-replay-child.ts", import.meta.url).pathname;
    const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", child, f.id], stdout: "piped", stderr: "piped" }).output();
    const stdout = new TextDecoder().decode(out.stdout).trim();
    const stderr = new TextDecoder().decode(out.stderr).trim();
    const line = stdout.split("\n").filter(Boolean).pop() || "";
    let v: any = null;
    try { v = JSON.parse(line); } catch { /* asserted below */ }
    assert(v, `${f.id}: the replay child produced no verdict (exit ${out.code}): ${stderr.slice(0, 400)}`);
    assert(!v.stage, `${f.id}: the replay failed at stage ${v.stage}: ${v.error}`);
    assert(v.contained === false, `${f.id}: the turn was contained, the live MUSE-F-011 failure (reply: ${JSON.stringify(v.reply).slice(0, 160)})`);
    assert(v.intent === "career_tailor", `${f.id}: intent is ${JSON.stringify(v.intent)}, expected career_tailor (reply: ${JSON.stringify(v.reply).slice(0, 160)})`);
    assert(v.artifactPdf === true, `${f.id}: artifact.pdf is null in the Buffer-free realm, MUSE-F-011 (the render threw before any bytes existed)`);
  });
}
