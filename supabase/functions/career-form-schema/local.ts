// WO-121 demo: one tick of the form-capture lane against a throwaway local Postgres, with the network off.
//   deno run -A supabase/functions/career-form-schema/local.ts [--since 2h] [--limit 50] [--ashby]
// The postings are tests/fixtures/forms-ci/sources.json. Every request is answered from files: a capture in
// tests/fixtures/form-schema/ (the raw answer, made by the capture workflow) when there is one; for Lever, else the captured
// /apply page in tests/fixtures/forms-ci/ (rendered, scripts removed), said as such; anything else is answered 503 "no
// capture", which the lane records as http_error. Nothing outside this machine is reached; the database is deleted at the end.
import { runFormLane, type FormRow, type TodoRow } from "./handler.ts";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const args = Deno.args, opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const sinceH = Number(/^(\d+)h$/.exec(opt("--since", "2h"))?.[1] ?? 2), limit = Number(opt("--limit", "50")), ashby = args.includes("--ashby");
const BIN = Deno.env.get("PGBIN") ?? "/usr/lib/postgresql/16/bin";
const root = Deno.uid?.() === 0;
const work = await Deno.makeTempDir({ dir: Deno.env.get("TMPDIR") ?? "/tmp", prefix: "wo121-" });
const PORT = String(54400 + Math.floor(Math.random() * 500));
async function sh(cmd: string, a: string[], stdin?: string): Promise<string> {
  const [c, aa] = root && /initdb|pg_ctl/.test(cmd) ? ["runuser", ["-u", "postgres", "--", cmd, ...a]] : [cmd, a];
  const p = new Deno.Command(c, { args: aa, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) { const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(stdin)); await w.close(); }
  const o = await p.output();
  if (!o.success) throw new Error(`${cmd}: ${new TextDecoder().decode(o.stderr)}`);
  return new TextDecoder().decode(o.stdout);
}
const psql = (sql: string) => sh("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-h", work, "-p", PORT, "-U", "postgres", "-d", "postgres", "-c", "set client_min_messages=warning", "-f", "-"], sql);

if (root) await sh("chown", ["postgres", work]);
await sh(`${BIN}/initdb`, ["-D", `${work}/data`, "-U", "postgres", "--auth=trust"]);
await sh(`${BIN}/pg_ctl`, ["-D", `${work}/data`, "-o", `-p ${PORT} -k ${work} -c listen_addresses=''`, "-l", `${work}/log`, "-w", "start"]);
try {
  for (const f of ["tests/db/stubs.sql", "supabase/migrations/20261019000001_career_postings.sql", "supabase/migrations/20261107100000_career_posting_forms.sql"]) {
    await psql(await Deno.readTextFile(`${ROOT}/${f}`));
  }
  // The fixture postings, first seen within the window.
  const sources = JSON.parse(await Deno.readTextFile(`${ROOT}/tests/fixtures/forms-ci/sources.json`)) as { id: string; family: string; company: string; url: string }[];
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const values = sources.map((s, i) => {
    const u = new URL(s.url), parts = u.pathname.split("/").filter(Boolean);
    const [board, id] = s.family === "greenhouse" ? [parts[0], parts[2]] : s.family === "smartrecruiters" ? [parts[2], s.id.split("-").pop()!] : [parts[0], parts[1]];
    const url = s.family === "lever" || s.family === "ashby" ? `${u.origin}/${board}/${id}` : s.url;
    return `(${q(`${s.family}:${board}:${id}`)}, ${q(s.family)}, ${q(board)}, ${q(id)}, ${q(s.company)}, 'Fixture posting', ${q(url)}, now() - interval '${(i * 3) % (sinceH * 60)} minutes', now())`;
  });
  await psql(`insert into public.career_postings(job_id, provider, board, ats_id, company, title, url, first_seen_at, last_seen_at) values ${values.join(",\n")};`);

  const dir = (p: string) => { try { return new Set([...Deno.readDirSync(p)].map((e) => e.name)); } catch { return new Set<string>(); } };
  const captures = dir(`${ROOT}/tests/fixtures/form-schema`), forms = dir(`${ROOT}/tests/fixtures/forms-ci`);
  const served: Record<string, number> = {}, ms: Record<string, number[]> = {};
  const fixtureFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input)), t0 = performance.now();
    let file: string | null = null, family = "";
    if (u.hostname === "boards-api.greenhouse.io") { const [, , , board, , id] = u.pathname.split("/"); family = "greenhouse"; file = captures.has(`greenhouse-${board}-${id}.json`) ? `form-schema/greenhouse-${board}-${id}.json` : null; }
    else if (u.hostname === "jobs.lever.co") {
      const [, site, id] = u.pathname.split("/"); family = "lever";
      file = captures.has(`lever-${site}-${id}.html`) ? `form-schema/lever-${site}-${id}.html` : forms.has(`lever-${site}-${id}.html`) ? `forms-ci/lever-${site}-${id}.html` : null;
    } else if (u.hostname === "jobs.ashbyhq.com") {
      const v = JSON.parse(String(init?.body ?? "{}")).variables ?? {}; family = "ashby";
      const n = `ashby-${String(v.organizationHostedJobsPageName).toLowerCase()}-${v.jobPostingId}.graphql.json`;
      file = captures.has(n) ? `form-schema/${n}` : null;
    } else throw new Error(`network is off: ${u.hostname} is not a fixture host`);
    const body = file ? await Deno.readTextFile(`${ROOT}/tests/fixtures/${file}`) : null;
    const from = file ? file.split("/")[0] : "none";
    served[from] = (served[from] ?? 0) + 1;
    (ms[family] ??= []).push(performance.now() - t0);
    return body === null ? new Response("no capture", { status: 503 }) : new Response(body, { status: 200 });
  };

  const t0 = Date.now();
  const out = await runFormLane({
    todo: async () => JSON.parse((await psql(`select coalesce(json_agg(t), '[]') from public.career_posting_forms_todo(now() - interval '${sinceH} hours', ${limit}) t;`)).trim()) as TodoRow[],
    put: async (rows: FormRow[]) => Number((await psql(`select public.career_posting_forms_put($wo121$${JSON.stringify(rows)}$wo121$::jsonb);`)).trim()),
    fetch: fixtureFetch as typeof fetch, now: Date.now, perHost: 4, gapMs: 250, ashbyGraphql: ashby, deadlineMs: 100_000,
    userAgent: "Trainee job alerts (contact: local demo)",
  });
  console.log(`tick: claimed ${out.claimed}, captured ${out.captured}, left for next tick ${out.left_for_next_tick}, model calls ${out.model_calls}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`responses served from: ${JSON.stringify(served)} (form-schema = raw capture; forms-ci = rendered page fallback; none = 503 no capture)`);
  const rows = (await psql(`select provider, job_id, state, coalesce(unread, ''), coalesce(detail, ''), jsonb_array_length(fields), (select count(*) from jsonb_array_elements(fields) e where (e->>'required')::boolean), coalesce(captcha_expected::text, '') from public.career_posting_forms order by provider, job_id;`)).trim().split("\n");
  for (const fam of ["greenhouse", "lever", "ashby", "smartrecruiters"]) {
    const mine = rows.filter((r) => r.startsWith(`${fam}|`)).map((r) => r.split("|"));
    const p = (ms[fam] ?? []).sort((a, b) => a - b), p95 = p.length ? p[Math.min(p.length - 1, Math.ceil(p.length * 0.95) - 1)].toFixed(1) : "n/a";
    const why: Record<string, number> = {};
    for (const r of mine) if (r[2] === "unread") why[r[3]] = (why[r[3]] ?? 0) + 1;
    console.log(`${fam}: captured ${mine.filter((r) => r[2] === "captured").length}/${mine.length}, unread ${JSON.stringify(why)}, p95 read ${p95} ms (local files)`);
    for (const r of mine) console.log(`  ${r[1]}: ${r[2] === "captured" ? `${r[5]} fields, ${r[6]} required, captcha_expected ${r[7]}` : `${r[3]} (${r[4]})`}`);
  }
  console.log("career_form_readiness(interval '24 hours'):");
  console.log((await psql(`select provider, first_seen, captured, captured_within_1h, unread_by_reason from public.career_form_readiness(interval '24 hours');`)).trim());
} finally {
  await sh(`${BIN}/pg_ctl`, ["-D", `${work}/data`, "-m", "immediate", "stop"]).catch(() => {});
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
