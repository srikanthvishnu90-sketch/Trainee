// ACK FAST variant of the Telegram acceptance suite (D-034 S4): the same journey, the same twelve steps and the same outcome
// assertions as tests/architect/telegram-acceptance.test.ts, with CHAT_QUEUE=on: each webhook queues the text and answers, and the
// real trainee-turn-worker handler runs the turn from the real queue table on Postgres. The flag-off run is that file as it is.
// This test runs that file in its own deno process with ACCEPTANCE_CHAT_QUEUE=on and requires every step to pass.
// Run (unprivileged user): deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/telegram-acceptance-queue.test.ts
import { pgBinDir } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
Deno.test({
  name: "Telegram acceptance with CHAT_QUEUE=on: the whole journey through the queue and the worker, every step passes",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const args = ["test", "-A", "--no-check", ...(Deno.env.get("IMPORT_MAP") ? [`--import-map=${Deno.env.get("IMPORT_MAP")}`] : []), `${ROOT}/tests/architect/telegram-acceptance.test.ts`];
    const out = await new Deno.Command(Deno.execPath(), { args, cwd: ROOT, env: { ...Deno.env.toObject(), ACCEPTANCE_CHAT_QUEUE: "on", NO_COLOR: "1" }, stdout: "piped", stderr: "piped" }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    const lines = log.split("\n").filter((l) => l.startsWith("TELEGRAM_ACCEPTANCE "));
    for (const l of lines) console.log(`QUEUE_ON ${l}`);
    if (out.code !== 0) throw new Error(`the acceptance journey failed with CHAT_QUEUE=on:\n${log.slice(-3000)}`);
    const summary = lines.find((l) => /known_gap=\d+ pass=\d+ fail=\d+/.test(l)) ?? "";
    const m = /pass=(\d+) fail=(\d+)/.exec(summary);
    if (!m || Number(m[2]) !== 0 || Number(m[1]) < 11) throw new Error(`unexpected summary: ${summary}`);
  },
});
