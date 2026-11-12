// REAL SETS (D-068, owner 2026-11-12 "Build real sets now"): the real public postings items 3 (resumes) and 13 (offer math)
// are measured on. One capture, run once, stored here; every runner replays these bytes and makes no request of its own.
//
// What it reads (public, read-only, no sign-in, no application, rate-limited to one request every 1.2 s):
//   Greenhouse       GET boards-api.greenhouse.io/v1/boards/<board>/jobs (the list, no content) to choose, then
//                    GET .../jobs/<id>?pay_transparency=true for each chosen posting (stored byte for byte)
//   Lever            GET api.lever.co/v0/postings/<company>?mode=json to choose, then GET .../postings/<company>/<id> (byte for byte)
//   Ashby            GET api.ashbyhq.com/posting-api/job-board/<org>?includeCompensation=true (the whole board, one request);
//                    the chosen job objects are stored as parsed (the board is several MB); the body's sha256 is recorded
//   SmartRecruiters  GET api.smartrecruiters.com/v1/companies/<co>/postings?limit=100 to choose, then GET .../postings/<id>
//   Workday (PayPal) POST paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs (the tenant's public search, one page per word),
//                    then GET .../wday/cxs/paypal/jobs<externalPath> for each chosen posting (byte for byte)
// Chosen: early-career and analyst titles the fictional persona (Alex Testcase, TEST) could target, in US places; the first
// ones by id, so a re-capture picks the same way. Nothing personal is read or stored: postings are employers' public pages.
//
//   deno run -A --no-check evals/real-sets/postings/capture.ts [--max 36]
// deno-lint-ignore-file no-explicit-any
const HERE = new URL(".", import.meta.url).pathname;
const UA = "Trainee measurement set (read-only; contact: unset)";
const GAP_MS = 1200;
const MAX = Number(Deno.args[Deno.args.indexOf("--max") + 1] || 36);
const TITLE = /\b(intern(ship)?|new grad|graduate|early career|university|junior|associate|analyst|software engineer|data (scientist|engineer)|financ)/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|architect|distinguished)\b/i;
const US = /\b(united states|usa|u\.s\.|us[- ]remote|remote[- ,(]*us|new york|nyc|san francisco|seattle|chicago|austin|boston|los angeles|denver|atlanta|miami|washington|ca\b|ny\b|wa\b|tx\b|il\b|ma\b|co\b|ga\b|nj\b|scottsdale|san jose|oakland|palo alto|mountain view|menlo park|sunnyvale|remote)\b/i;

let last = 0;
async function get(url: string, init: RequestInit = {}): Promise<{ status: number; body: string; at: string }> {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const at = new Date().toISOString();
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30000) });
  return { status: res.status, body: await res.text(), at };
}
async function sha(s: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const pick = (jobs: any[], title: (j: any) => string, place: (j: any) => string, id: (j: any) => string, n: number) =>
  jobs.filter((j) => TITLE.test(title(j)) && !SENIOR.test(title(j)) && US.test(place(j))).sort((a, b) => String(id(a)).localeCompare(String(id(b)))).slice(0, n);

interface Source { file: string; provider: string; board: string; id: string; title: string; request: string; status: number; at: string; sha256: string; stored: "byte for byte" | "the job object from the board's answer"; board_sha256?: string }
const sources: Source[] = [];
await Deno.mkdir(`${HERE}recorded`, { recursive: true });
async function keep(s: Omit<Source, "sha256" | "file">, body: string) {
  const file = `${s.provider}-${s.board}-${s.id}.json`.replace(/[^\w.-]+/g, "_");
  await Deno.writeTextFile(`${HERE}recorded/${file}`, body);
  sources.push({ file, ...s, sha256: await sha(body) });
  console.log(`kept ${file}: ${s.title}`);
}
const full = () => sources.length >= MAX;

const GH = ["stripe", "airbnb", "figma", "robinhood", "coinbase", "datadog", "duolingo", "brex", "affirm", "gusto", "discord", "dropbox", "chime", "toast"];
for (const b of GH) {
  if (full()) break;
  const l = await get(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs`);
  if (l.status !== 200) { console.log(`greenhouse ${b}: HTTP ${l.status}`); continue; }
  for (const j of pick(JSON.parse(l.body).jobs ?? [], (j) => j.title, (j) => j.location?.name ?? "", (j) => String(j.id), 1)) {
    if (full()) break;
    const url = `https://boards-api.greenhouse.io/v1/boards/${b}/jobs/${j.id}?pay_transparency=true`;
    const r = await get(url);
    if (r.status === 200) await keep({ provider: "greenhouse", board: b, id: String(j.id), title: j.title, request: `GET ${url}`, status: r.status, at: r.at, stored: "byte for byte" }, r.body);
  }
}
for (const b of ["palantir", "spotify", "zoox"]) {
  if (full()) break;
  const l = await get(`https://api.lever.co/v0/postings/${b}?mode=json`);
  if (l.status !== 200) { console.log(`lever ${b}: HTTP ${l.status}`); continue; }
  for (const j of pick(JSON.parse(l.body), (j) => j.text, (j) => j.categories?.location ?? "", (j) => j.id, 2)) {
    if (full()) break;
    const url = `https://api.lever.co/v0/postings/${b}/${j.id}`;
    const r = await get(url);
    if (r.status === 200) await keep({ provider: "lever", board: b, id: j.id, title: j.text, request: `GET ${url}`, status: r.status, at: r.at, stored: "byte for byte" }, r.body);
  }
}
for (const b of ["ramp", "notion", "plaid"]) {
  if (full()) break;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`;
  const l = await get(url);
  if (l.status !== 200) { console.log(`ashby ${b}: HTTP ${l.status}`); continue; }
  const boardSha = await sha(l.body);
  for (const j of pick(JSON.parse(l.body).jobs ?? [], (j) => j.title, (j) => `${j.location ?? ""} ${j.isRemote ? "remote" : ""}`, (j) => j.id, 2)) {
    if (full()) break;
    await keep({ provider: "ashby", board: b, id: j.id, title: j.title, request: `GET ${url}`, status: l.status, at: l.at, stored: "the job object from the board's answer", board_sha256: boardSha }, JSON.stringify(j));
  }
}
for (const b of ["servicenow", "Experian", "Wise"]) {
  if (full()) break;
  const l = await get(`https://api.smartrecruiters.com/v1/companies/${b}/postings?limit=100`);
  if (l.status !== 200) { console.log(`smartrecruiters ${b}: HTTP ${l.status}`); continue; }
  const place = (j: any) => [j.location?.city, j.location?.region, j.location?.country === "us" ? "United States" : j.location?.country].filter(Boolean).join(", ");
  for (const j of pick(JSON.parse(l.body).content ?? [], (j) => j.name, place, (j) => j.id, 2)) {
    if (full()) break;
    const url = `https://api.smartrecruiters.com/v1/companies/${b}/postings/${j.id}`;
    const r = await get(url);
    if (r.status === 200) await keep({ provider: "smartrecruiters", board: b, id: String(j.id), title: j.name, request: `GET ${url}`, status: r.status, at: r.at, stored: "byte for byte" }, r.body);
  }
}
for (const word of ["intern", "software engineer", "data analyst"]) {
  if (full()) break;
  const s = await get("https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: word }) });
  if (s.status !== 200) { console.log(`workday paypal "${word}": HTTP ${s.status}`); continue; }
  const list = (JSON.parse(s.body).jobPostings ?? []).filter((j: any) => /United States/.test(String(j.locationsText ?? j.externalPath)) || /-United-States-of-America\//.test(j.externalPath));
  for (const j of pick(list, (j) => j.title, () => "United States", (j) => j.externalPath, 2)) {
    if (full()) break;
    if (sources.some((x) => x.provider === "workday" && x.id === j.externalPath.split("_").pop())) continue;
    const url = `https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs${j.externalPath}`;
    const r = await get(url);
    if (r.status === 200) await keep({ provider: "workday", board: "paypal", id: j.externalPath.split("_").pop(), title: j.title, request: `GET ${url}`, status: r.status, at: r.at, stored: "byte for byte" }, r.body);
  }
}
await Deno.writeTextFile(`${HERE}sources.json`, JSON.stringify({ note: "Captured by evals/real-sets/postings/capture.ts: public job-board APIs, read-only, user agent '" + UA + "', one request every 1.2 s. No sign-in, no application, nothing sent.", sources }, null, 1) + "\n");
console.log(`CAPTURE: ${sources.length} postings (${[...new Set(sources.map((s) => s.provider))].map((p) => `${p} ${sources.filter((s) => s.provider === p).length}`).join(", ")})`);
