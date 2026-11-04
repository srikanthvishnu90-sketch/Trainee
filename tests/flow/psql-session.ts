// One long-lived psql session (no driver download needed: the Postgres 16 client the flow harness already uses). Each
// query is sent with a unique end marker and its rows read back; one query at a time per session. Used by the scale load
// test, where a new psql per call (tests/flow/pg.ts) would measure process start-up, not the database.
export interface Session { q: (sql: string) => Promise<string[]>; close: () => Promise<void> }
export function psqlSession(o: { host: string; port: number; bin: string; role?: string }): Session {
  const child = new Deno.Command(`${o.bin}/psql`, {
    args: ["-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=0", "-h", o.host, "-p", String(o.port), "-U", "postgres", "-d", "postgres"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter(), enc = new TextEncoder();
  const lines: string[] = [], errs: string[] = [];
  let wake = null as (() => void) | null;
  (async () => {
    let pending = "";
    for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
      pending += c;
      const parts = pending.split("\n");
      pending = parts.pop()!;
      lines.push(...parts);
      wake?.();
    }
  })();
  (async () => { for await (const c of child.stderr.pipeThrough(new TextDecoderStream())) { errs.push(c); wake?.(); } })();
  let chain: Promise<unknown> = Promise.resolve();
  const role = o.role ? `set role ${o.role};\n` : "";
  let ready = false;
  const q = (sql: string) => {
    const run = chain.then(async () => {
      const mark = `__END_${crypto.randomUUID().replace(/-/g, "")}`;
      errs.length = 0;
      await w.write(enc.encode(`${ready ? "" : role}${sql};\n\\echo ${mark}\n`));
      ready = true;
      while (true) {
        const i = lines.indexOf(mark);
        if (i >= 0) {
          const out = lines.splice(0, i + 1).slice(0, -1).filter((l) => l !== "");
          const err = errs.join("").trim();
          if (/ERROR:/.test(err)) throw Error(err.split("\n").find((l) => /ERROR:/.test(l)) ?? err);
          return out;
        }
        await new Promise<void>((r) => (wake = r));
      }
    });
    chain = run.catch(() => {});
    return run;
  };
  return { q, close: async () => { await w.close().catch(() => {}); await child.status; } };
}
