// Live posting read + Gmail "did I already apply" (architect, 2026-11-15). Found in a real-task comparison: asked "Open the live
// posting for Vista Equity Partners 2028 PE Summer Analyst Internship, job id 3048 ... check my Gmail for any sign I already
// applied", get_posting only read postings already on file, so it never opened the live page; a later attempt hit "redirected too
// many times" on the employer's careers site (a cookie-set redirect loop) and gave up. No Gmail read happened.
//
// Now: get_posting opens the live posting link when the copy on file is missing or stale, through one bounded read
// (posting_live.ts readLivePosting: at most 8 redirects, a cookie jar per read so a cookie-set loop resolves, a time limit, a size
// cap, HTML to text), on top of posting_fetch.ts guardedFetch (https only, public named hosts, never LinkedIn or Indeed). A read
// that fails says so (D-024) and returns no requirements (D-007). check_applied_in_gmail searches the person's connected Gmail
// (read only) and returns evidence (subject, date, sender), or says it is unconfirmed when Gmail is not connected.
//
// Every request here goes to a local stub server standing in for the employer's host (the transport rewrites the host; the
// guarded rules still see the https address asked).
import { LIVE_MAX_BYTES, LIVE_MAX_HOPS, readLivePosting } from "../../../supabase/functions/_shared/posting_live.ts";
import { fetchAsAsked } from "../../../supabase/functions/_shared/posting_fetch.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { capabilityTools } from "../../../supabase/functions/_shared/agent/capability_tools.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

const HOST = "https://careers.vistaequitypartners.com";
const PUBLIC = async () => ["93.184.216.34"]; // the stub host "resolves" to a public address
const POSTING_HTML = `<!doctype html><html><head><title>2028 PE Summer Analyst Internship | Vista Equity Partners</title>
<script>window.track = 1;</script><style>.x{color:red}</style></head><body><h1>2028 PE Summer Analyst Internship</h1>
<p>Vista Equity Partners is seeking Summer Analysts for its Private Equity group in Austin, TX.</p>
<h2>Qualifications</h2><ul><li>Pursuing a bachelor's degree with an expected graduation date of 2029</li>
<li>Strong financial modeling and accounting coursework</li><li>Proficiency in Excel and PowerPoint</li></ul>
<p>Applications are reviewed on a rolling basis.</p></body></html>`;

// A local server for HOST; `handler` sees the path and the request. Returns the transport and a stop function.
async function stub(handler: (path: string, req: Request) => Response | Promise<Response>) {
  const hits: { path: string; cookie: string | null }[] = [];
  const ac = new AbortController();
  let port = 0;
  const ready = new Promise<void>((res) => {
    Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: (a) => { port = (a as Deno.NetAddr).port; res(); } }, async (req) => {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      hits.push({ path, cookie: req.headers.get("cookie") });
      return await handler(path, req);
    });
  });
  await ready;
  const raw = (input: string, init?: RequestInit) => fetch(String(input).replace(HOST, `http://127.0.0.1:${port}`), init);
  return { fetch: fetchAsAsked(raw as any), hits, stop: () => ac.abort() };
}

Deno.test("live-posting/1 a cookie-set redirect loop resolves with the read's own cookie jar, and the page is read as text", async () => {
  // The employer's careers site: /job/3048 sets a session cookie and sends you to /gate; /gate without that cookie sends you back.
  // A reader without cookies loops until "redirected too many times"; with the jar, the second visit carries the cookie.
  const s = await stub((path, req) => {
    const has = /(?:^|;\s*)vsess=ok/.test(req.headers.get("cookie") ?? "");
    if (path.startsWith("/job/3048")) return has ? new Response(POSTING_HTML, { headers: { "content-type": "text/html" } })
      : new Response(null, { status: 302, headers: { location: "/gate?next=/job/3048", "set-cookie": "vsess=ok; Path=/; Secure; HttpOnly" } });
    if (path.startsWith("/gate")) return new Response(null, { status: 302, headers: { location: "/job/3048" } });
    return new Response("not found", { status: 404 });
  });
  try {
    const r: any = await readLivePosting(`${HOST}/job/3048`, { fetch: s.fetch, resolve: PUBLIC });
    eq(r.status, "read", JSON.stringify(r));
    assert(/2028 PE Summer Analyst Internship/.test(r.title), `title: ${r.title}`);
    assert(/financial modeling/.test(r.text) && /Excel and PowerPoint/.test(r.text), r.text);
    assert(!/<|window\.track|color:red/.test(r.text), `scripts, styles and tags are not text: ${r.text}`);
    assert(s.hits.length <= LIVE_MAX_HOPS + 1, `bounded: ${s.hits.length} requests`);
    assert(s.hits.some((h) => h.cookie && /vsess=ok/.test(h.cookie)), "the cookie the site set was sent back");
  } finally { s.stop(); }
});

Deno.test("live-posting/2 a redirect loop that never resolves stops at 8 hops and says so; nothing is guessed", async () => {
  eq(LIVE_MAX_HOPS, 8);
  let n = 0;
  const s = await stub(() => new Response(null, { status: 302, headers: { location: `/loop/${++n}`, "set-cookie": `c${n}=1; Path=/` } }));
  try {
    const r: any = await readLivePosting(`${HOST}/loop/0`, { fetch: s.fetch, resolve: PUBLIC });
    eq(r.status, "not_read");
    assert(/redirected more than 8 times/.test(r.why), r.why);
    eq(s.hits.length, LIVE_MAX_HOPS + 1, "the first request and 8 redirects, no more");
    eq(r.text, undefined, "no text from a read that failed");
  } finally { s.stop(); }
});

Deno.test("live-posting/3 LinkedIn and Indeed are never requested", async () => {
  const asked: string[] = [];
  const f = async (u: string) => { asked.push(u); return new Response(POSTING_HTML); };
  for (const u of ["https://www.linkedin.com/jobs/view/3048", "https://lnkd.in/abc", "https://www.indeed.com/viewjob?jk=3048", "https://uk.indeed.com/viewjob?jk=1"]) {
    const r: any = await readLivePosting(u, { fetch: f as any, resolve: PUBLIC });
    eq(r.status, "not_read", u);
    assert(/never opens/.test(r.why), r.why);
  }
  // A redirect from the employer's site onto LinkedIn is refused at that hop too.
  const s = await stub(() => new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/jobs/view/3048" } }));
  try {
    const r: any = await readLivePosting(`${HOST}/job/3048`, { fetch: s.fetch, resolve: PUBLIC });
    eq(r.status, "not_read");
    assert(/never opens/.test(r.why), r.why);
  } finally { s.stop(); }
  eq(asked.length, 0, "no request reached LinkedIn or Indeed");
});

Deno.test("live-posting/4 a page past the size cap is not read; a page that does not answer in time is not read", async () => {
  assert(LIVE_MAX_BYTES <= 2 * 1024 * 1024, "the cap is at most 2 MB");
  const big = "<p>" + "x".repeat(LIVE_MAX_BYTES + 1024) + "</p>";
  let release = () => {};
  const held = new Promise<void>((res) => { release = res; });
  const s = await stub(async (path) => {
    if (path === "/big") return new Response(big, { headers: { "content-type": "text/html" } });
    if (path === "/slow") { await held; return new Response(POSTING_HTML); }
    return new Response("", { status: 404 });
  });
  try {
    const r: any = await readLivePosting(`${HOST}/big`, { fetch: s.fetch, resolve: PUBLIC });
    eq(r.status, "not_read");
    assert(/larger than/.test(r.why), r.why);
    const t0 = Date.now();
    const slow: any = await readLivePosting(`${HOST}/slow`, { fetch: s.fetch, resolve: PUBLIC, timeoutMs: 300 });
    eq(slow.status, "not_read");
    assert(/timeout|did not answer/.test(slow.why), slow.why);
    assert(Date.now() - t0 < 3000, `the time limit held: ${Date.now() - t0} ms`);
  } finally { release(); await new Promise((r) => setTimeout(r, 50)); s.stop(); }
});

Deno.test("live-posting/5 a captcha or bot wall is reported as not read, never solved", async () => {
  const s = await stub(() => new Response(`<html><head><title>Just a moment...</title></head><body><div class="g-recaptcha" data-sitekey="x"></div>Please verify you are a human</body></html>`, { status: 200, headers: { "content-type": "text/html" } }));
  try {
    const r: any = await readLivePosting(`${HOST}/job/3048`, { fetch: s.fetch, resolve: PUBLIC });
    eq(r.status, "not_read");
    assert(/captcha|bot check/.test(r.why), r.why);
    eq(s.hits.length, 1, "one GET; nothing is submitted to the wall");
  } finally { s.stop(); }
});

const ctx = (now = Date.parse("2026-11-15T12:00:00Z")) => ({ userId: "u", threadId: "t", now, state: {} }) as any;

Deno.test("live-posting/6 get_posting opens the live link when the posting is not on file, and reads it", async () => {
  const s = await stub((path, req) => /vsess=ok/.test(req.headers.get("cookie") ?? "") || path.startsWith("/gate")
    ? (path.startsWith("/gate") ? new Response(null, { status: 302, headers: { location: "/job/3048" } }) : new Response(POSTING_HTML))
    : new Response(null, { status: 302, headers: { location: "/gate", "set-cookie": "vsess=ok; Path=/" } }));
  try {
    const t = careerTools({ postings: async () => [], posting: async () => null,
      livePosting: (u: string) => readLivePosting(u, { fetch: s.fetch, resolve: PUBLIC }) } as any).find((x) => x.name === "get_posting")!;
    assert((t.input_schema as any).properties.url, "get_posting takes the posting's link");
    const r: any = await t.run({ job_id: "3048", url: `${HOST}/job/3048` }, ctx());
    eq(r.source, "live", JSON.stringify(r).slice(0, 300));
    assert(/financial modeling/.test(r.text), r.text);
    eq(r.url, `${HOST}/job/3048`);
    assert(r.read_at, "says when it was read");
  } finally { s.stop(); }
});

Deno.test("live-posting/7 a stale copy on file is re-read live; a fresh one is not", async () => {
  const s = await stub(() => new Response(POSTING_HTML));
  try {
    const old = { job_id: "3048", company: "Vista Equity Partners", title: "2028 PE Summer Analyst Internship", location: "Austin, TX", url: `${HOST}/job/3048`,
      description: "Old text. Requirements: nothing current.", first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-20T00:00:00Z", closed_at: null };
    const mk = (p: any) => careerTools({ postings: async () => [], posting: async () => p,
      livePosting: (u: string) => readLivePosting(u, { fetch: s.fetch, resolve: PUBLIC }) } as any).find((x) => x.name === "get_posting")!;
    const stale: any = await mk(old).run({ job_id: "3048" }, ctx());
    eq(stale.source, "live");
    assert(/financial modeling/.test(stale.text), stale.text);
    const before = s.hits.length;
    const fresh: any = await mk({ ...old, description: POSTING_HTML.replace(/<[^>]+>/g, " "), last_seen_at: "2026-11-15T06:00:00Z" }).run({ job_id: "3048" }, ctx());
    eq(fresh.source, "on_file");
    eq(s.hits.length, before, "a fresh copy on file makes no request");
  } finally { s.stop(); }
});

Deno.test("live-posting/8 a live read that fails says so honestly and gives no requirements (D-024, D-007)", async () => {
  const s = await stub(() => new Response(null, { status: 302, headers: { location: "/again", "set-cookie": "x=1" } }));
  try {
    const t = careerTools({ postings: async () => [], posting: async () => null,
      livePosting: (u: string) => readLivePosting(u, { fetch: s.fetch, resolve: PUBLIC }) } as any).find((x) => x.name === "get_posting")!;
    const r: any = await t.run({ job_id: "3048", url: `${HOST}/job/3048` }, ctx());
    eq(r.status, "not_read");
    assert(/redirected more than 8 times/.test(r.why), r.why);
    eq([r.text, r.requirements, r.pay], [undefined, undefined, undefined], "nothing about the job is returned from a failed read");
    assert(/could not open/i.test(r.note) && /never guess|do not guess/i.test(r.note) && r.note.includes(`link`), r.note);
    // A LinkedIn link is refused without a request, and said so the same way.
    const li: any = await t.run({ job_id: "3048", url: "https://www.linkedin.com/jobs/view/3048" }, ctx());
    eq(li.status, "not_read");
    assert(/never opens/.test(li.why), li.why);
    // The copy on file stays available, marked as the old copy, when the live read fails.
    const t2 = careerTools({ postings: async () => [], posting: async () => ({ job_id: "3048", company: "Vista Equity Partners", title: "Summer Analyst", location: "", url: `${HOST}/job/3048`,
      description: "Requirements: Excel.", first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-02T00:00:00Z", closed_at: null }),
      livePosting: (u: string) => readLivePosting(u, { fetch: s.fetch, resolve: PUBLIC }) } as any).find((x) => x.name === "get_posting")!;
    const kept: any = await t2.run({ job_id: "3048" }, ctx());
    eq([kept.source, kept.live_read?.status], ["on_file", "not_read"]);
    assert(/could not open/i.test(kept.note) && /2026-09-02/.test(kept.note), kept.note);
  } finally { s.stop(); }
});

// ---- Gmail: "check my Gmail for any sign I already applied" -------------------------------------------------------------
const capDeps = (inbox: any) => ({ mail: null, tracking: true, accounts: null, cursor: null, readNow: null, connectUrl: "https://trainee.example/connect/gmail",
  situation: null, snapshot: null, files: null, people: null, inbox, reply: null }) as any;

Deno.test("live-posting/9 check_applied_in_gmail returns evidence from the connected Gmail (read only)", async () => {
  const queries: string[] = [];
  const inbox = {
    search: async (_u: string, q: string) => { queries.push(q); return { status: "ok", mails: [
      { ref: "m1", account: "me@gmail.com", thread_id: "t1", from: "no-reply@vistaequitypartners.com", from_name: "Vista Equity Partners Recruiting", reply_to: null,
        subject: "Thank you for applying: 2028 PE Summer Analyst Internship", date: "2026-10-02T14:00:00.000Z", snippet: "We received your application.", message_id: null },
    ] }; },
    read: async () => { throw new Error("check_applied_in_gmail never opens a whole email"); },
  };
  const t = capabilityTools(capDeps(inbox)).find((x) => x.name === "check_applied_in_gmail");
  assert(t, "the tool exists when Gmail can be read");
  eq(t!.effect, "read");
  const r: any = await t!.run({ employer: "Vista Equity Partners", role: "2028 PE Summer Analyst Internship" }, ctx());
  eq(r.status, "evidence_found", JSON.stringify(r));
  eq(r.evidence.length, 1);
  eq([r.evidence[0].date, r.evidence[0].from], ["2026-10-02T14:00:00.000Z", "no-reply@vistaequitypartners.com"]);
  assert(/Thank you for applying/.test(JSON.stringify(r.evidence[0])), "the subject is returned as evidence");
  assert(/Vista Equity Partners/.test(queries[0]), queries[0]);
});

Deno.test("live-posting/10 check_applied_in_gmail: nothing found is not 'did not apply'; not connected is unconfirmed", async () => {
  const none = { search: async () => ({ status: "ok", mails: [] }), read: async () => ({ status: "missing" }) };
  const t = capabilityTools(capDeps(none)).find((x) => x.name === "check_applied_in_gmail")!;
  const r: any = await t.run({ employer: "Vista Equity Partners" }, ctx());
  eq(r.status, "no_evidence_found");
  assert(/not proof|does not mean|doesn't mean/i.test(r.note), r.note);
  const unwired = { search: async () => ({ status: "NOT_WIRED" }), read: async () => ({ status: "NOT_WIRED" }) };
  const u: any = await capabilityTools(capDeps(unwired)).find((x) => x.name === "check_applied_in_gmail")!.run({ employer: "Vista Equity Partners" }, ctx());
  eq(u.status, "unconfirmed");
  eq(u.connect_url, "https://trainee.example/connect/gmail");
  const absent = capabilityTools(capDeps(null)).find((x) => x.name === "check_applied_in_gmail");
  assert(absent, "without a Gmail reader the tool still answers, as unconfirmed");
  const a: any = await absent!.run({ employer: "Vista Equity Partners" }, ctx());
  eq(a.status, "unconfirmed");
  assert(/not connected|isn't connected|is not connected/i.test(a.note), a.note);
});
