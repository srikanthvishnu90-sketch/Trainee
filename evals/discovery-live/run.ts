// Release item 8 (job discovery), B on LIVE public job boards, read-only, $0 (docs/architect/VERIFICATION-15.md item 8).
// Bar: "Current openings verified on the employer page, matched to the person, an honest count, and a scope given when the
// result is empty."
//
// What runs, and what is real:
//   1. Index: the product's own ingest (supabase/functions/_shared/career_ingest.ts ingestBoards + boardFetchFeed, the code the
//      scheduled career-ingest function runs) reads the public boards listed in evals/discovery-live/boards.json, once each,
//      4 at a time, into memory. Nothing is written anywhere but this run's throwaway Postgres.
//   2. Search: every search in SEARCHES below goes through the REAL handler (agent-chat handler-career.ts handleChat, via
//      tests/flow/handler.ts: real supabase-js over the PostgREST double, Postgres 16 with every migration), shipped flags,
//      staged brain, a scripted model on the Anthropic wire (no model is called, $0). The product's open check (D-051, E.21)
//      reads each posting it shows on its own page by id over the REAL network: Greenhouse, Lever and SmartRecruiters public
//      posting APIs, the Ashby posting page. Any other outbound host is refused and counted.
//   3. Re-check: after each reply, every shown link is re-fetched independently by id (same public endpoints; for Ashby the
//      posting page must carry "posting":{"id":"<id>"}; a removed Ashby posting answers 404), so "open now" is this
//      harness's own read, not the product's claim.
//
// Scored per search (bars are the loop-08 bars, on live data): invented (a shown link that is no posting the boards listed),
// dead_now (re-check says closed or gone), count_dishonest, empty_no_scope, unmarked_unchecked. Reported, not barred:
// off_scope (title, level or place outside the ask, by the keyword rules in SEARCHES), unknown_now (re-check could not finish).
//
// Run: deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/discovery-live/run.ts [--out <dir>]
//      (Postgres 16 binaries; runs as root through runuser like the flow tests). Nothing is applied for, queued or sent.
import { boardFetchFeed, ingestBoards, memoryPostingsDb, type Board, type Posting } from "../../supabase/functions/_shared/career_ingest.ts";
import { startPg } from "../../tests/flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../../tests/flow/handler.ts";
import { anthropicWire } from "../../tests/architect/helpers/anthropic_wire.ts";
import boards from "./boards.json" with { type: "json" };

const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = opt("--out") ?? new URL(`./runs/${RUN_ID}/`, import.meta.url).pathname;
const PAUSE_MS = 1500; // between searches: the boards' rate limits

interface Search { id: string; text: string; role: RegExp | null; intern: boolean; place: RegExp | null; want: number | null; expectEmpty?: boolean }
const SF = /San Francisco|\bSF\b|Bay Area/i, NY = /New York|\bNYC\b/i, CHI = /Chicago/i, REMOTE = /remote/i;
export const SEARCHES: Search[] = [
  { id: "data-analyst/chicago/intern/3", text: "Find me 3 data analyst internships in Chicago that are actually open. Show the company, role, location and link. Don't apply yet.", role: /data|analy/i, intern: true, place: CHI, want: 3 },
  { id: "software-engineer/sf/any/5", text: "Find 5 software engineer jobs in San Francisco. Show the real links.", role: /software|engineer/i, intern: false, place: SF, want: 5 },
  { id: "product-manager/remote-us/any/5", text: "Find 5 product manager roles remote in the US. Show the real links.", role: /product manager|product management|\bPM\b/i, intern: false, place: REMOTE, want: 5 },
  { id: "software-engineer/nyc/intern", text: "Show me open software engineering internships in New York. Don't apply to anything.", role: /software|engineer/i, intern: true, place: NY, want: null },
  { id: "data-scientist/seattle/any/3", text: "Find 3 data scientist jobs in Seattle. Show the company, role and application link.", role: /data scien/i, intern: false, place: /Seattle/i, want: 3 },
  { id: "marketing/austin/any", text: "Find marketing jobs in Austin, TX. Show the company, role and application link.", role: /marketing/i, intern: false, place: /Austin/i, want: null },
  { id: "product-designer/nyc/any/4", text: "Find 4 product designer roles in New York.", role: /design/i, intern: false, place: NY, want: 4 },
  { id: "account-executive/chicago/any/3", text: "Find 3 account executive jobs in Chicago.", role: /account executive/i, intern: false, place: CHI, want: 3 },
  { id: "ml-engineer/sf/any/5", text: "Find 5 machine learning engineer jobs in San Francisco.", role: /machine learning|\bML\b|AI/i, intern: false, place: SF, want: 5 },
  { id: "financial-analyst/nyc/any/3", text: "Find 3 financial analyst roles in New York.", role: /financ/i, intern: false, place: NY, want: 3 },
  { id: "sre-devops/remote-us/any/5", text: "Find 5 site reliability or DevOps engineer roles remote in the US.", role: /reliability|devops|\bSRE\b|infrastructure|platform/i, intern: false, place: REMOTE, want: 5 },
  { id: "recruiter/london/any/3", text: "Find 3 recruiter jobs in London.", role: /recruit|talent/i, intern: false, place: /London/i, want: 3 },
  { id: "data-engineer/toronto/any/3", text: "Find 3 data engineer jobs in Toronto.", role: /data engineer/i, intern: false, place: /Toronto/i, want: 3 },
  { id: "customer-success/denver/any/3", text: "Find 3 customer success manager roles in Denver.", role: /customer success/i, intern: false, place: /Denver/i, want: 3 },
  { id: "security-engineer/remote-us/any/5", text: "Find 5 security engineer jobs remote in the US.", role: /security/i, intern: false, place: REMOTE, want: 5 },
  { id: "business-analyst/chicago/intern/2", text: "Find 2 business analyst internships in Chicago.", role: /analy/i, intern: true, place: CHI, want: 2 },
  { id: "backend-engineer/dublin/any/3", text: "Find 3 backend engineer jobs in Dublin, Ireland.", role: /backend|back-end|software|engineer/i, intern: false, place: /Dublin/i, want: 3 },
  { id: "sales-development/austin/any/3", text: "Find 3 sales development representative jobs in Austin.", role: /sales development|\bSDR\b|\bBDR\b|business development/i, intern: false, place: /Austin/i, want: 3 },
  { id: "empty/marine-biologist/boise/3", text: "Find me 3 marine biologist jobs in Boise, Idaho.", role: /marine biolog/i, intern: false, place: /Boise/i, want: 3, expectEmpty: true },
  { id: "empty/economist/peoria/intern/3", text: "Find 3 economist internships in Peoria, Illinois. Show the links.", role: /econom/i, intern: true, place: /Peoria/i, want: 3, expectEmpty: true },
  { id: "empty/pastry-chef/anchorage", text: "Find pastry chef jobs in Anchorage, Alaska.", role: /pastry|chef/i, intern: false, place: /Anchorage/i, want: null, expectEmpty: true },
  { id: "empty/airline-pilot/fargo/2", text: "Find 2 commercial airline pilot jobs in Fargo, North Dakota.", role: /pilot/i, intern: false, place: /Fargo/i, want: 2, expectEmpty: true },
];

// ------------------------------------------------------------------------------------------------ the reply, as loop-08 reads it
const items = (reply: string) => reply.split("\n").filter((l) => /^\d+\. /.test(l));
const block = (reply: string, i: number) => {
  const lines = reply.split("\n"), k = lines.findIndex((l) => l.startsWith(`${i}. `));
  if (k < 0) return "";
  const rest: string[] = [];
  for (const l of lines.slice(k + 1)) { if (/^\s{3}/.test(l)) rest.push(l); else break; }
  return [lines[k], ...rest].join("\n");
};
const urlOf = (line: string) => /\((https?:\/\/[^\s)]+)\)/.exec(line)?.[1] ?? /(https?:\/\/\S+)/.exec(line)?.[1]?.replace(/[).,]+$/, "") ?? null;
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ------------------------------------------------------------------------------------------------ the independent re-check
type Now = "open" | "gone" | "unknown";
async function recheck(f: typeof fetch, p: Posting): Promise<{ state: Now; url: string; status: number | null }> {
  const [provider, board, ...rest] = p.job_id.split(":"), id = rest.join(":");
  const url = provider === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`
    : provider === "lever" ? `https://api.lever.co/v0/postings/${board}/${id}`
    : provider === "smartrecruiters" ? `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}`
    : `https://jobs.ashbyhq.com/${board}/${id}`;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    const r = await f(url, { headers: { "user-agent": "Trainee discovery eval (read-only)", accept: "application/json,text/html" }, signal: ctl.signal }).finally(() => clearTimeout(t));
    const body = await r.text();
    if (r.status === 404 || r.status === 410) return { state: "gone", url, status: r.status };
    if (!r.ok) return { state: "unknown", url, status: r.status };
    if (provider === "ashby") return { state: body.includes(`"posting":{"id":"${id.toLowerCase()}"`) ? "open" : body.includes(`"posting":null`) ? "gone" : "unknown", url, status: r.status };
    if (provider === "smartrecruiters") { const j = JSON.parse(body); return { state: j?.active === false ? "gone" : "open", url, status: r.status }; }
    return { state: "open", url, status: r.status };
  } catch {
    return { state: "unknown", url, status: null };
  }
}

// ------------------------------------------------------------------------------------------------ run
const realFetch = globalThis.fetch;
await Deno.mkdir(OUT, { recursive: true });
const log = (s: string) => console.log(s);

// 1. The index, by the product's own ingest.
const mem = memoryPostingsDb();
const t0 = Date.now();
const ingest = await ingestBoards({ boards: boards as Board[], fetchFeed: boardFetchFeed(realFetch, { userAgent: "Trainee discovery eval (read-only)" }), db: mem, now: Date.now(), maxBoards: boards.length, concurrency: 4 });
const postings = await mem.open();
log(`INGEST boards=${ingest.attempted} ok=${ingest.boards_ok} failed=${ingest.boards_failed} partial=${ingest.boards_partial} open_postings=${postings.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const f of ingest.failures) log(`  ingest failed ${f.provider}:${f.board}: ${f.error}`);
const BY_URL = new Map(postings.map((p) => [p.url, p]));
const byProvider: Record<string, number> = {};
for (const p of postings) byProvider[p.provider] = (byProvider[p.provider] ?? 0) + 1;
if (args.includes("--ingest-only")) Deno.exit(0); // before startPg: no cluster or template exists yet

// 2. Postgres with every migration, the index loaded, one synthetic person per search.
const pg = await startPg();
const people = Object.fromEntries(SEARCHES.map((_, i) => [`p${i}`, `8e0f8f8e-6a43-4a49-9d2c-${String(900000000000 + i)}`]));
const results: any[] = [];
let outbound: string[] = [];
try {
  await supabaseParity(pg);
  const ids = Object.values(people);
  await pg.sql(`insert into auth.users (id, email) values ${ids.map((id) => `('${id}', '${id}@example.test')`).join(", ")};
    insert into public.profiles (id) values ${ids.map((id) => `('${id}')`).join(", ")};
    insert into public.career_watch_kv (user_id, key, value) values ${ids.map((id) => `('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}')`).join(", ")};`);
  const cols = ["job_id", "provider", "board", "ats_id", "company", "title", "location", "url", "description", "department", "posted_at", "remote", "role_family", "seniority_band", "first_seen_at", "last_seen_at", "closed_at", "pay", "apply_email"];
  // If the throwaway cluster is SQL_ASCII, char_length counts bytes: a field is cut to its
  // column limit in UTF-8 bytes (whole characters), or a posting whose pay has en dashes fails a check the live UTF8 database passes.
  const enc = new TextEncoder();
  const clip = (s: unknown, n: number) => { if (s == null) return s; let t = String(s); while (enc.encode(t).length > n) t = [...t].slice(0, -Math.max(1, Math.ceil((enc.encode(t).length - n) / 3))).join(""); return t; };
  // Disk (this machine has well under 1 GB free): the index load writes no WAL beyond what it must. Small max_wal_size and a
  // checkpoint every 1,000 rows keep pg_wal recycled; the table is set unlogged when nothing references it (a throwaway cluster).
  await pg.sql(`alter system set max_wal_size = '64MB'; alter system set min_wal_size = '32MB';`);
  await pg.sql(`select pg_reload_conf();`);
  const unlogged = await pg.sql(`alter table public.career_postings set unlogged;`).then(() => true, () => false);
  log(`INDEX table unlogged=${unlogged}`);
  for (let i = 0; i < postings.length; i += 50) {
    if (i % 1000 === 0) await pg.sql(`checkpoint;`);
    const rows = postings.slice(i, i + 50).map((p: any) => ({ ...p, pay: clip(p.pay, 200), description: clip(p.description ?? "", 20000), location: clip(p.location ?? "", 1000), department: clip(p.department ?? "", 300), title: clip(p.title, 500), company: clip(p.company, 300) }));
    const tag = `$j${crypto.randomUUID().replace(/-/g, "")}$`;
    try {
      await pg.sql(`insert into public.career_postings (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_recordset(null::public.career_postings, ${tag}${JSON.stringify(rows)}${tag}) on conflict (job_id) do nothing;`);
    } catch (e) {
      if (Deno.env.get("DL_DEBUG")) { console.log(`batch ${i}: ${e}`); console.log(Deno.readTextFileSync(`${pg.host}/log`).split("\n").filter((l) => /PANIC|TRAP|FATAL|ERROR|WARNING|abort|memory/i.test(l)).map((l) => l.slice(0, 400)).join("\n")); }
      throw e;
    }
  }
  log(`DB encoding ${await pg.sql(`show server_encoding`)}`);
  log(`INDEX loaded ${await pg.sql(`select count(*) from public.career_postings where closed_at is null`)} open postings`);

  for (const k of ["CAREER_BRAIN", "CAREER_SEARCH_OPEN_CHECK", "MODEL_PROVIDER", "CAREER_MODEL"]) Deno.env.delete(k);
  const h = await careerHandler(pg, people);
  const viaDouble = globalThis.fetch;
  let pageReads: string[] = [];
  const supa = new URL(SUPABASE_URL).host;
  const BOARD_HOSTS = new Set(["boards-api.greenhouse.io", "api.lever.co", "api.smartrecruiters.com", "jobs.ashbyhq.com", "api.ashbyhq.com", "boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.smartrecruiters.com"]);
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host === "api.anthropic.com") return anthropicWire(req, (b: any) => Response.json({ id: "c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "A model reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));
    if (u.host === supa) return await viaDouble(req);
    if (BOARD_HOSTS.has(u.host) && req.method === "GET") { pageReads.push(u.href); return await realFetch(req); }
    outbound.push(`${req.method} ${u.host}`);
    throw new TypeError(`network refused: ${u.host}`);
  }) as typeof fetch;
  Deno.env.set("CAREER_BRAIN", "staged");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
  const n = async (sql: string) => Number(await pg.sql(sql));
  const effects = async () => [await n(`select count(*) from public.career_apply_jobs`), await n(`select count(*) from public.career_apply_wanted`), await n(`select count(*) from public.career_send_queue`)].join("/");
  const zero = await effects();

  for (const [i, s] of SEARCHES.entries()) {
    pageReads = [];
    const r = await h.chat(`p${i}`).say(s.text);
    const reads = [...pageReads];
    const reply = r.reply, list = items(reply), faults: string[] = [];
    const row: any = { id: s.id, asked: s.text, status: r.status, intent: r.intent, shown: list.length, checked_open_marked: 0, invented: 0, open_now: 0, dead_now: 0, unknown_now: 0, unmarked_unchecked: 0, count_dishonest: 0, empty_no_scope: 0, off_scope: 0, page_reads: reads.length, listing_reads: reads.filter((u) => /\/posting-api\/job-board\/|\/v1\/boards\/[^/]+\/jobs\/?(\?|$)|\/v0\/postings\/[^/]+\/?(\?|$)|\/postings\/?(\?|$)/.test(u)).length, postings: [] as any[] };
    for (const [k, line] of list.entries()) {
      const b = block(reply, k + 1), url = urlOf(line), p = url ? BY_URL.get(url) : undefined;
      const saysOpen = /Checked: open on/i.test(b);
      if (saysOpen) row.checked_open_marked++;
      if (!url || !p) { row.invented++; faults.push(`invented: ${line.slice(0, 140)}`); row.postings.push({ line: line.slice(0, 200), url, in_index: false }); continue; }
      const now = await recheck(realFetch, p);
      if (now.state === "open") row.open_now++; else if (now.state === "gone") { row.dead_now++; faults.push(`dead now: ${p.job_id} (${now.status})`); } else row.unknown_now++;
      if (!saysOpen && !/could not (?:re-)?check|not re-checked|couldn['’]t (?:re-)?check|not checked|unconfirmed|limited check/i.test(b)) { row.unmarked_unchecked++; faults.push(`shown neither as checked open nor as unchecked: ${p.job_id}`); }
      const inScope = (!s.role || s.role.test(p.title)) && (!s.intern || /intern|co-?op|apprentice|summer|student|graduate/i.test(p.title)) && (!s.place || s.place.test(`${p.location ?? ""} ${p.title}`));
      if (!inScope) { row.off_scope++; faults.push(`off scope: "${p.title}" / "${p.location}" for ${s.id}`); }
      row.postings.push({ job_id: p.job_id, company: p.company, title: p.title, location: p.location, url: p.url, marked_checked_open: saysOpen, recheck: now.state, recheck_status: now.status, in_scope: inScope });
    }
    const verified = /I verified (\d+|one|two|three|four|five|six|seven|eight|nine|ten) open match/i.exec(reply)?.[1];
    const v = verified ? (WORDS[verified.toLowerCase()] ?? Number(verified)) : null;
    const unchecked = /^(\d+) listed, not re-checked\./m.exec(reply)?.[1];
    if (list.length && (unchecked ? Number(unchecked) !== list.length || row.checked_open_marked > 0 : v !== row.checked_open_marked)) { row.count_dishonest++; faults.push(`count: says ${v ?? unchecked ?? "no count"}, ${row.checked_open_marked} rows checked open of ${list.length}`); }
    if (s.want && list.length > s.want) { row.count_dishonest++; faults.push(`count: ${list.length} shown for ${s.want} asked`); }
    if (s.want && list.length && list.length < s.want && !new RegExp(`did not find ${s.want}\\b`).test(reply)) { row.count_dishonest++; faults.push(`count: ${list.length} of ${s.want} without saying so`); }
    if (!list.length && !(/I checked .+ in .+/.test(reply) && /widening|widen/i.test(reply))) { row.empty_no_scope++; faults.push("empty without scope and widening"); }
    if (reads.length > 10) faults.push(`checks: ${reads.length} posting-page reads (cap 10)`);
    if (row.listing_reads) faults.push(`board listing read during the search: ${row.listing_reads}`);
    row.faults = faults;
    row.reply = reply;
    results.push(row);
    log(`SEARCH ${s.id}: shown=${row.shown} marked_open=${row.checked_open_marked} open_now=${row.open_now} dead_now=${row.dead_now} unknown_now=${row.unknown_now} invented=${row.invented} count_dishonest=${row.count_dishonest} empty_no_scope=${row.empty_no_scope} off_scope=${row.off_scope} reads=${row.page_reads}${faults.length ? `\n  ${faults.join("\n  ")}` : ""}`);
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }
  const after = await effects();
  globalThis.fetch = realFetch;
  h.restore();

  const sum = (k: string) => results.reduce((a, r) => a + (r[k] ?? 0), 0);
  const empties = results.filter((r) => r.shown === 0);
  const totals = {
    searches: results.length, shown: sum("shown"), checked_open_marked: sum("checked_open_marked"), open_now: sum("open_now"), dead_now: sum("dead_now"), unknown_now: sum("unknown_now"),
    invented: sum("invented"), unmarked_unchecked: sum("unmarked_unchecked"), count_dishonest: sum("count_dishonest"), empty_results: empties.length, empty_no_scope: sum("empty_no_scope"),
    expected_empty: SEARCHES.filter((s) => s.expectEmpty).length, expected_empty_returned_empty: results.filter((r, i) => SEARCHES[i].expectEmpty && r.shown === 0).length,
    off_scope: sum("off_scope"), page_reads: sum("page_reads"), max_page_reads_one_search: Math.max(...results.map((r) => r.page_reads)), listing_reads: sum("listing_reads"),
    searches_over_10_reads: results.filter((r) => r.page_reads > 10).length, outbound_refused: outbound.length, effects_before_after: `${zero} -> ${after}`,
  };
  const bar = totals.invented === 0 && totals.dead_now === 0 && totals.unmarked_unchecked === 0 && totals.count_dishonest === 0 && totals.empty_no_scope === 0 && totals.searches_over_10_reads === 0 && totals.listing_reads === 0 && zero === after;
  const out = { run_id: RUN_ID, at: new Date().toISOString(), commit: (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim()).catch(() => null)),
    ingest: { boards: ingest.attempted, ok: ingest.boards_ok, failed: ingest.boards_failed, partial: ingest.boards_partial, open_postings: postings.length, by_provider: byProvider, failures: ingest.failures },
    bar: "invented + dead_now + unmarked_unchecked + count_dishonest + empty_no_scope == 0, <= 10 posting reads and no listing read per search, nothing queued or sent", pass: bar, totals, outbound, searches: results };
  await Deno.writeTextFile(`${OUT}/results.json`, JSON.stringify(out, null, 1) + "\n");
  await Deno.writeTextFile(`${OUT}/transcripts.md`, results.map((r) => `## ${r.id}\n\n> ${r.asked}\n\n\`\`\`\n${r.reply}\n\`\`\`\n\n${r.faults.length ? r.faults.map((f: string) => `- ${f}`).join("\n") : "- no faults"}\n`).join("\n"));
  log(`DISCOVERY-LIVE run=${RUN_ID} ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(" ")} result=${bar ? "PASS" : "FAIL"}`);
  log(`wrote ${OUT}`);
} finally {
  globalThis.fetch = realFetch;
  await pg.stop().catch(() => {});
  // tests/flow/pg.ts removes its cluster template on "unload", which an uncaught error skips (Deno 2.9.6): each such run left a
  // ~68 MB /tmp/trainee-flow-pg-template-* behind. Fire it here, on every path out (removal is idempotent).
  globalThis.dispatchEvent(new Event("unload"));
}
Deno.exit(0);
