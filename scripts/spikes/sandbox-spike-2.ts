// Sandbox spike 2 (docs/architect/specs/SANDBOX-SPIKE-2-PLAN.md): Vercel Sandbox latency and network deny.
// Runs only by hand, never in CI: `deno run -A scripts/spikes/sandbox-spike-2.ts --yes-owner-approved [--reps 5]`, with
// VERCEL_OIDC_TOKEN in the environment (from `vercel env pull` in a scratch folder outside the repo). Makes no model call.
// Every sandbox: 1 vCPU, not persistent, a short timeout, stop() in finally. Prints JSON results to stdout.
import { Sandbox } from "npm:@vercel/sandbox@3.9.1";

if (!Deno.args.includes("--yes-owner-approved")) { console.error("refusing: pass --yes-owner-approved (owner, 2026-11-15)"); Deno.exit(2); }
if (Deno.env.get("CI")) { console.error("refusing: never runs in CI"); Deno.exit(2); }
const reps = Number(Deno.args[Deno.args.indexOf("--reps") + 1] ?? 5) || 5;
const HERE = new URL("./sandbox-spike-2/", import.meta.url);
const read = (f: string) => Deno.readFileSync(new URL(f, HERE));
const DIR = "/tmp/bundle";
let creations = 0, vcpuMs = 0;

type Opts = { image?: string; networkPolicy?: unknown; timeout?: number; source?: unknown };
async function withBox<T>(o: Opts, fn: (s: Sandbox, createMs: number) => Promise<T>): Promise<T> {
  const t0 = performance.now();
  // deno-lint-ignore no-explicit-any
  const s = await Sandbox.create({ resources: { vcpus: 1 }, persistent: false, timeout: o.timeout ?? 60_000, networkPolicy: (o.networkPolicy ?? "deny-all") as any, ...(o.image ? { image: o.image } : {}), ...(o.source ? { source: o.source } : {}) } as never);
  creations++;
  const createMs = performance.now() - t0;
  try { return await fn(s, createMs); } finally { await s.stop().catch(() => {}); vcpuMs += performance.now() - t0; }
}
async function run(s: Sandbox, cmd: string, args: string[] = [], cwd?: string) {
  const t0 = performance.now();
  const r = await s.runCommand({ cmd, args, ...(cwd ? { cwd } : {}) } as never) as unknown as { exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> };
  return { ms: performance.now() - t0, exit: r.exitCode, out: (await r.stdout()).slice(-400), err: (await r.stderr()).slice(-400) };
}
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { median: Math.round(s[Math.floor(s.length / 2)]), worst: Math.round(s[s.length - 1]), n: s.length }; };
async function bundle(s: Sandbox, ledger = "ledger.py") {
  await run(s, "mkdir", ["-p", DIR]);
  await s.writeFiles([{ path: `${DIR}/ledger.py`, content: Buffer.from(read(ledger)) }, { path: `${DIR}/test_ledger.py`, content: Buffer.from(read("test_ledger.py")) }] as never);
}
import { Buffer } from "node:buffer";
const out: Record<string, unknown> = { sdk: "@vercel/sandbox@3.9.1", started: new Date().toISOString() };

// A, B: cold create and a first command, per image.
for (const [k, image] of [["A", "vercel/sandbox/python:3.14"], ["B", undefined]] as const) {
  const c: number[] = [], r: number[] = [];
  for (let i = 0; i < reps; i++) await withBox({ image }, async (s, ms) => { c.push(ms); r.push((await run(s, "python3", ["-c", "print(1)"])).ms); });
  out[k] = { image: image ?? "universal (default)", create: stats(c), firstCommand: stats(r) };
}
// D: the 40-test bundle; E: real code plus three mutants in one session.
{
  const tot: number[] = [], res: unknown[] = [];
  for (let i = 0; i < reps; i++) await withBox({ image: "vercel/sandbox/python:3.14" }, async (s, ms) => {
    const t0 = performance.now(); await bundle(s); const r = await run(s, "python3", ["-m", "unittest", "-q", "test_ledger"], DIR);
    tot.push(ms + performance.now() - t0); res.push({ exit: r.exit, tail: r.err.trim().split("\n").slice(-2).join(" | ") });
  });
  out.D = { total: stats(tot), results: res };
}
{
  const tot: number[] = []; let last: unknown = null;
  for (let i = 0; i < reps; i++) await withBox({ image: "vercel/sandbox/python:3.14" }, async (s, ms) => {
    const t0 = performance.now(); const rs: unknown[] = [];
    for (const f of ["ledger.py", "mutant1.py", "mutant2.py", "mutant3.py"]) { await bundle(s, f); const r = await run(s, "python3", ["-m", "unittest", "-q", "test_ledger"], DIR); rs.push({ variant: f, exit: r.exit, tail: r.err.trim().split("\n").slice(-1)[0] }); }
    tot.push(ms + performance.now() - t0); last = rs;
  });
  out.E = { total: stats(tot), last };
}
// F: a 2 MB output, and a session timeout that must reject runCommand (reported "not run (timed out)", never passed).
await withBox({ image: "vercel/sandbox/python:3.14", timeout: 20_000 }, async (s) => {
  const big = await run(s, "python3", ["-c", "import sys; sys.stdout.write('x' * 2_000_000)"]);
  let timeout = "no rejection (FAIL)";
  try { const r = await run(s, "python3", ["-c", "import time; time.sleep(60); print('slept')"]); timeout = `resolved after ${Math.round(r.ms)} ms, exit ${r.exit}, out ${JSON.stringify(r.out.trim())}`; } catch (e) { timeout = `rejected: ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`; }
  out.F = { bigOutputExit: big.exit, bigOutputMs: Math.round(big.ms), timeout };
});
// Network deny probes; the control runs the HTTPS and DNS probes once with allow-all.
const PROBES: [string, string][] = [
  ["dns system", "getent hosts example.com"],
  ["dns udp 8.8.8.8", "python3 -c \"import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(4);s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'),('8.8.8.8',53));print(s.recv(512)[:4])\""],
  ["dns udp 1.1.1.1", "python3 -c \"import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(4);s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'),('1.1.1.1',53));print(s.recv(512)[:4])\""],
  ["https name", "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' https://example.com"],
  ["http name", "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://example.com"],
  ["https raw ip", "curl -sSk --max-time 5 -o /dev/null -w '%{http_code}' https://1.1.1.1"],
  ["tcp 443", "python3 -c \"import socket;socket.create_connection(('1.1.1.1',443),5);print('connected')\""],
  ["tcp 80", "python3 -c \"import socket;socket.create_connection(('1.1.1.1',80),5);print('connected')\""],
  ["ipv6", "curl -6 -sS --max-time 5 -o /dev/null -w '%{http_code}' 'https://[2606:4700:4700::1111]'"],
  ["icmp", "ping -c1 -W2 1.1.1.1"],
  ["metadata", "curl -sS --max-time 3 http://169.254.169.254/latest/meta-data/"],
  ["pip", "pip download requests --no-deps -d /tmp/x -q --timeout 5"],
];
const probe = async (s: Sandbox) => {
  const rows: unknown[] = [];
  for (const [name, c] of PROBES) { const r = await run(s, "bash", ["-c", `timeout 8 ${c}`]); rows.push({ name, exit: r.exit, out: r.out.trim().slice(0, 80), err: r.err.trim().split("\n").slice(-1)[0]?.slice(0, 120) }); }
  const env = await run(s, "bash", ["-c", "env | cut -d= -f1 | sort | tr '\\n' ' '; echo; grep -rlI 'OIDC\\|VERCEL_TOKEN' /vercel 2>/dev/null | head -3"]);
  return { rows, envNames: env.out.trim() };
};
out.denyAll = await withBox({ image: "vercel/sandbox/python:3.14" }, probe);
out.allowAll = await withBox({ image: "vercel/sandbox/python:3.14", networkPolicy: "allow-all" }, async (s) => {
  const rows: unknown[] = [];
  for (const [name, c] of PROBES.filter(([n]) => n === "https name" || n === "dns system")) { const r = await run(s, "bash", ["-c", `timeout 8 ${c}`]); rows.push({ name, exit: r.exit, out: r.out.trim().slice(0, 80) }); }
  return rows;
});
out.used = { creations, vcpuMinutesUpperBound: +(vcpuMs / 60_000).toFixed(2) };
console.log(JSON.stringify(out, null, 2));
