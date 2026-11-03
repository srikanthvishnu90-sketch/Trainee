// WO-081 (architect), the second half of WO-071: main's landing page and its capture backend on trunk, so trunk is the
// one line (D-026). main's 20261019020000_site_capture.sql is live in production, so it keeps its version and its bytes;
// trunk's 20261019020000_channel_delivery.sql, which held the same version and has never been deployed, moved to the
// next free version (git mv, content unchanged) so a version-based push can never skip either one. The two public
// capture functions are main's files byte for byte; here they run over a stubbed Deno.serve and a fake network.
// Contract: docs/architect/work-orders/WO-081-port-sweep.md. Run: deno test -A --no-check tests/architect/
const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
async function sha256(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MIGRATIONS: string[] = [];
for await (const e of Deno.readDir(new URL("supabase/migrations/", ROOT))) if (e.isFile && e.name.endsWith(".sql")) MIGRATIONS.push(e.name);
MIGRATIONS.sort();

// sha256 of the files as they are on main @ 8e940754 (site_capture.sql is unchanged since ff47bf91, the live-verified
// commit; the functions too).
const LIVE_FILES: Record<string, string> = {
  "supabase/migrations/20261019020000_site_capture.sql": "fc9e3bf24d122d8b4ce707a7bee4fbda76124a5b37580ab4b6b9a26b26c04124",
};

Deno.test("WO-081/1 the live site capture keeps its version and its bytes; channel delivery moved to the next free version", async () => {
  for (const [p, want] of Object.entries(LIVE_FILES)) eq(await sha256(Deno.readFileSync(new URL(p, ROOT))), want, `${p} is main's live file, byte for byte`);
  eq(MIGRATIONS.filter((f) => f.startsWith("20261019020000_")), ["20261019020000_site_capture.sql"], "version 20261019020000 is the live site capture's alone");
  eq(MIGRATIONS.filter((f) => f.endsWith("_channel_delivery.sql")), ["20261019020001_channel_delivery.sql"], "channel delivery's one file, re-versioned");
  // Dependency order kept: after the outbox it alters (career_alerts) and before the inbound migration that redefines its claim.
  const at = (f: string) => MIGRATIONS.indexOf(f);
  assert(at("20261019010001_career_alerts.sql") < at("20261019020001_channel_delivery.sql"), "the outbox exists before delivery alters it");
  assert(at("20261019020001_channel_delivery.sql") < at("20261019030000_channel_inbound.sql"), "delivery comes before inbound");
  assert(read("supabase/migrations/20261019020001_channel_delivery.sql").includes("create or replace function public.career_outbox_contacts_on"), "the delivery migration's content is unchanged");
});

Deno.test("WO-081/2 go-live applies the site capture only when the live schema lacks it, and channel delivery under its new name", () => {
  const sh = read("scripts/launch/trainee-go-live.sh");
  const list = /\nMIGRATIONS=\(\n([\s\S]*?)\n\)/.exec(sh)![1].trim().split(/\s+/);
  const marks = /\nMIGRATION_MARK=\(\n([\s\S]*?)\n\)/.exec(sh)![1].trim().split("\n").map((l) => l.trim());
  eq(list.length, marks.length, "one live-schema mark per migration");
  const i = list.indexOf("20261019020000_site_capture.sql");
  assert(i >= 0, "go-live lists the site capture");
  eq(list[i + 1], "20261019020001_channel_delivery.sql", "then channel delivery, in file order");
  assert(!list.includes("20261019020000_channel_delivery.sql"), "the old name is gone");
  for (const obj of ["public.site_waitlist", "public.site_careers_applications", "careers-resumes"]) assert(marks[i].includes(obj), `the mark checks ${obj}`);
  assert(marks[i + 1].includes("career_outbox_contacts_on"), "channel delivery keeps its mark");
  assert(!/supabase db push/.test(sh.replace(/^#.*$/gm, "")), "never a version-based push");
  for (const p of ["tests/db/run.sh", "supabase/functions/_shared/channel_store.ts", "docs/launch/TRAINEE-GO-LIVE.md"]) {
    assert(!read(p).includes("20261019020000_channel_delivery"), `${p} names channel delivery by its new version`);
  }
  assert(read("tests/db/run.sh").includes("20261019020000_site_capture.sql"), "the DB suite applies the site capture");
});

Deno.test("WO-081/3 the two capture functions are public on purpose (verify_jwt off) and ship no key", () => {
  const toml = read("supabase/config.toml");
  for (const fn of ["site-signup", "site-careers"]) {
    assert(new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = false`).test(toml), `${fn} is a public endpoint`);
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert(src.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")'), `${fn} reads the service key from its environment`);
    assert(!/eyJ[A-Za-z0-9_-]{20,}|sb_secret_|sk-[A-Za-z0-9]/.test(src), `${fn} carries no key`);
  }
});

// The functions call Deno.serve at load; the stub keeps the handler instead of listening.
type Handler = (req: Request) => Promise<Response>;
async function loadHandler(fn: string): Promise<Handler> {
  // deno-lint-ignore no-explicit-any
  const d = Deno as any, orig = d.serve;
  let h: Handler | null = null;
  d.serve = (x: Handler) => { h = x; return { finished: Promise.resolve(), shutdown: async () => {} }; };
  try { await import(new URL(`supabase/functions/${fn}/index.ts?wo081=${crypto.randomUUID()}`, ROOT).href); } finally { d.serve = orig; }
  assert(h, `${fn} registered a handler`);
  return h!;
}
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
async function withFakeNetwork(status: (c: Call) => number, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [], origFetch = globalThis.fetch;
  Deno.env.set("SUPABASE_URL", "https://fake-project.supabase.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-SSSSSSSS");
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw ?? null;
    const c = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    calls.push(c);
    return new Response("{}", { status: status(c) });
  };
  try { await run(calls); } finally { globalThis.fetch = origFetch; Deno.env.delete("SUPABASE_URL"); Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); }
}
const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("https://x.test/fn", { method: "POST", body, headers });

Deno.test("WO-081/4 site-signup: a consented signup lands in site_waitlist with the service role; every refusal writes nothing", async () => {
  const h = await loadHandler("site-signup");
  await withFakeNetwork(() => 201, async (calls) => {
    eq((await h(new Request("https://x.test/fn", { method: "OPTIONS" }))).status, 200, "CORS preflight");
    eq((await h(new Request("https://x.test/fn"))).status, 405, "GET is refused");
    eq((await h(post("{not json"))).status, 400, "bad JSON");
    eq((await h(post(JSON.stringify({ name: " ", phone: "+15550001234", consent: true })))).status, 400, "no name");
    eq((await h(post(JSON.stringify({ name: "Test Visitor", phone: "", consent: true })))).status, 400, "no phone");
    eq((await h(post(JSON.stringify({ name: "Test Visitor", phone: "+15550001234", consent: "yes" })))).status, 400, "consent must be true itself");
    eq(calls.length, 0, "no refusal reaches the database");
    const ok = await h(post(JSON.stringify({ list: "waitlist", name: " Test Visitor ", phone: "+15550001234", consent: true, consentText: "I agree", consentAt: "not a date", source: "hero" })));
    eq([ok.status, await ok.json()], [200, { ok: true }]);
    eq(calls.length, 1);
    eq(calls[0].url, "https://fake-project.supabase.test/rest/v1/site_waitlist");
    eq([calls[0].method, calls[0].headers.authorization, calls[0].headers.apikey], ["POST", "Bearer fake-service-role-key-SSSSSSSS", "fake-service-role-key-SSSSSSSS"]);
    eq(calls[0].body, { name: "Test Visitor", phone: "+15550001234", consent: true, consent_text: "I agree", consent_at: null, source: "hero" }, "trimmed; an unparseable consent time is kept as null");
  });
  await withFakeNetwork(() => 500, async () => {
    const r = await h(post(JSON.stringify({ name: "Test Visitor", phone: "+15550001234", consent: true, consentAt: "2026-10-19T00:00:00Z" })));
    eq(r.status, 500, "a failed insert is a failure the page shows");
  });
});

Deno.test("WO-081/5 site-careers: the resume goes to the private bucket, then its row; a failed row removes the file", async () => {
  const h = await loadHandler("site-careers");
  const form = (name: string, email: string, file?: File) => { const f = new FormData(); f.set("name", name); f.set("email", email); if (file) f.set("resume", file); return f; };
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], "My Resume.P!DF", { type: "application/pdf" });
  await withFakeNetwork(() => 200, async (calls) => {
    eq((await h(post(JSON.stringify({ name: "x" }), { "content-type": "application/json" }))).status, 400, "not multipart");
    eq((await h(post(form("", "a@example.test", pdf)))).status, 400, "no name");
    eq((await h(post(form("Test Applicant", "a@example.test")))).status, 400, "no file");
    eq((await h(post(form("Test Applicant", "a@example.test", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf"))))).status, 413, "over 10 MB");
    eq(calls.length, 0, "no refusal reaches storage or the database");
    const ok = await h(post(form("Test Applicant", "applicant@example.test", pdf)));
    eq(ok.status, 200);
    eq(calls.length, 2, "one upload, one row");
    const m = /^https:\/\/fake-project\.supabase\.test\/storage\/v1\/object\/careers-resumes\/([0-9a-f-]{36})\.pdf$/.exec(calls[0].url);
    assert(m, `the file goes to the private bucket under a random name with its sanitized extension: ${calls[0].url}`);
    eq([calls[0].headers["content-type"], calls[0].headers["x-upsert"]], ["application/pdf", "false"]);
    eq(calls[1].url, "https://fake-project.supabase.test/rest/v1/site_careers_applications");
    eq(calls[1].body, { name: "Test Applicant", email: "applicant@example.test", resume_path: `${m![1]}.pdf` });
  });
  await withFakeNetwork((c) => (c.url.includes("/rest/v1/") ? 500 : 200), async (calls) => {
    eq((await h(post(form("Test Applicant", "applicant@example.test", pdf)))).status, 500);
    eq(calls.map((c) => c.method), ["POST", "POST", "DELETE"], "the orphaned file is deleted");
    eq(calls[2].url, calls[0].url);
  });
});

Deno.test("WO-081/6 the page posts only to the two capture functions on the Upmore project, and ships no key", () => {
  const html = read("site/index.html");
  const endpoints = [...new Set(html.match(/https:\/\/[a-z0-9]+\.supabase\.co\/[^'"\s)]*/g) ?? [])].sort();
  eq(endpoints, ["https://mrwngntwmnaqrqhupvlt.supabase.co/functions/v1/site-careers", "https://mrwngntwmnaqrqhupvlt.supabase.co/functions/v1/site-signup"]);
  assert(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sb_secret_|sb_publishable_|service_role/.test(html), "no Supabase key of any kind");
  assert(/fetch\(C\.signupEndpoint/.test(html) && /fetch\(C\.careersEndpoint/.test(html), "the forms post to the configured endpoints");
});
