// WO-004 hardening (Codex's finding on PR #3, confirmed 2026-10-19): the simulator never carries one person's
// attachment to another. Needs process and file permissions, so it lives with the architect tests (run with -A), not
// the permissionless edge suite. Run: deno test -A --no-check tests/architect/wo-004-simulator-isolation.test.ts
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }

Deno.test("WO-004/H5 the simulator drops pending attachments when switching person or forgetting one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/resume.txt`, "Ada Lovelace. Analyst.");
    await Deno.writeTextFile(`${dir}/script.txt`, [`/attach ${dir}/resume.txt`, "/as +15550004444", `/attach ${dir}/resume.txt`, "/reset", "/quit"].join("\n"));
    const run = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", "scripts/text.ts", "--fresh", "--as", "+15550005555", "--script", `${dir}/script.txt`], cwd: new URL("../../", import.meta.url), stdout: "piped", stderr: "piped", env: { ANTHROPIC_API_KEY: "" } }).output();
    const text = new TextDecoder().decode(run.stdout);
    assert(text.includes("(dropped 1 attachment meant for +15550005555)"), text);
    assert(text.includes("(dropped 1 attachment meant for +15550004444)"), text);
  } finally { await Deno.remove(dir, { recursive: true }); }
});

// The router's searches read the simulator's postings, the way agent-chat hands the router its discovery pool each turn
// (handler-career.ts, CareerPool). Before this, every router search in the simulator answered "the current list is
// empty" whatever /post or --postings held, so offline router testing could not test search at all.
Deno.test("WO-004/H6 a router search in the simulator ranks the postings it holds", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/script.txt`, ["/post Data Analyst | Stripe | Chicago, IL", "find me data analyst jobs", "/quit"].join("\n"));
    const run = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", "scripts/text.ts", "--fresh", "--brain", "router", "--as", "+15550006666", "--script", `${dir}/script.txt`], cwd: new URL("../../", import.meta.url), stdout: "piped", stderr: "piped", env: { ANTHROPIC_API_KEY: "" } }).output();
    const text = new TextDecoder().decode(run.stdout);
    assert(!text.includes("the current list is empty"), text);
    assert(text.includes("Data Analyst at Stripe"), text);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
