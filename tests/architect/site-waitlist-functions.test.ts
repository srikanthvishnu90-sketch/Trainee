// Review of #487 (site: waitlist survey + owner waitlist viewer), fixed forward:
//   site-admin  — the key only from the x-admin-key header (a ?key= is refused even when right), compared in constant
//                 time, and every response is no-store with a strict Referrer-Policy.
//   site-survey — a survey only for a phone on the waitlist, at most one per phone, source kept as a path only.
//   pages       — name and phone reach /survey through sessionStorage, never the URL.
// Handlers take env and fetch as inputs (no Deno.env, no network): supabase/functions/site-{admin,survey}/handler.ts.
import assert, { deepStrictEqual as assertEquals } from "node:assert/strict";
import { createAdminHandler, keyMatches } from "../../supabase/functions/site-admin/handler.ts";
import { createSurveyHandler, sourcePath, waitlistPhone } from "../../supabase/functions/site-survey/handler.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));

const ENV: Record<string, string> = {
  SITE_ADMIN_KEY: "owner-test-key-not-a-secret",
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
};
const env = (over: Record<string, string | undefined> = {}) => (k: string) => (k in over ? over[k] : ENV[k]);

type Call = { url: string; method: string; body?: string };
// A fake PostgREST: GET returns the rows the test holds for that table and phone filter; POST appends.
function fakeDb(rows: { site_waitlist?: { phone: string; name?: string }[]; site_waitlist_survey?: { phone: string }[] } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    site_waitlist: [...(rows.site_waitlist ?? [])],
    site_waitlist_survey: [...(rows.site_waitlist_survey ?? [])],
  };
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ url: url.href, method, body: init?.body as string | undefined });
    const table = url.pathname.replace("/rest/v1/", "");
    if (!(table in tables)) return Promise.resolve(new Response("no such table", { status: 404 }));
    if (method === "POST") {
      tables[table].push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    const eq = url.searchParams.get("phone");
    const out = eq ? tables[table].filter((r) => `eq.${r.phone}` === eq) : tables[table];
    return Promise.resolve(Response.json(out));
  }) as typeof fetch;
  return { fetchFn, calls, tables };
}

const ADMIN_URL = "https://fn.example.test/functions/v1/site-admin";
const noStore = (r: Response) => {
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(r.headers.get("referrer-policy"), "no-referrer");
};

Deno.test("site-admin: the right key in the x-admin-key header shows the lists, no-store", async () => {
  const db = fakeDb({ site_waitlist: [{ phone: "+13125550123", name: "Ada" }] });
  const h = createAdminHandler({ env: env(), fetchFn: db.fetchFn });
  const r = await h(new Request(ADMIN_URL, { headers: { "x-admin-key": ENV.SITE_ADMIN_KEY } }));
  assertEquals(r.status, 200);
  noStore(r);
  const html = await r.text();
  assert(html.includes("+13125550123") && html.includes("Ada"), "the waitlist row is on the page");
  assertEquals(db.calls.length, 2, "both lists were read");
});

Deno.test("site-admin: a key in the URL is refused even when it is right, and nothing is read", async () => {
  const db = fakeDb({ site_waitlist: [{ phone: "+13125550123" }] });
  const h = createAdminHandler({ env: env(), fetchFn: db.fetchFn });
  for (const headers of [{}, { "x-admin-key": ENV.SITE_ADMIN_KEY }] as Record<string, string>[]) {
    const r = await h(new Request(`${ADMIN_URL}?key=${ENV.SITE_ADMIN_KEY}`, { headers }));
    assertEquals(r.status, 401);
    noStore(r);
    assert(!(await r.text()).includes("+13125550123"));
  }
  assertEquals(db.calls.length, 0);
});

Deno.test("site-admin: a wrong or missing key is refused, no-store; the form sends the key in a header", async () => {
  const db = fakeDb({ site_waitlist: [{ phone: "+13125550123" }] });
  const h = createAdminHandler({ env: env(), fetchFn: db.fetchFn });
  for (const k of ["wrong", "", ENV.SITE_ADMIN_KEY + "x", ENV.SITE_ADMIN_KEY.slice(0, -1)]) {
    const r = await h(new Request(ADMIN_URL, { headers: { "x-admin-key": k } }));
    assertEquals(r.status, 401, `key ${JSON.stringify(k)}`);
    noStore(r);
    await r.body?.cancel();
  }
  const form = await h(new Request(ADMIN_URL));
  assertEquals(form.status, 401);
  noStore(form);
  const page = await form.text();
  assert(/'x-admin-key': k/.test(page) && /location\.pathname/.test(page), "the form fetches this path with the key in a header");
  assert(!/[?&]key=/.test(page), "and never puts it in a URL");
  assertEquals(db.calls.length, 0);
});

Deno.test("site-admin: not configured is 503 with no-store; keyMatches compares content", async () => {
  const h = createAdminHandler({ env: env({ SITE_ADMIN_KEY: undefined }), fetchFn: fakeDb().fetchFn });
  const r = await h(new Request(ADMIN_URL, { headers: { "x-admin-key": "anything" } }));
  assertEquals(r.status, 503);
  noStore(r);
  await r.body?.cancel();
  assert(await keyMatches("abc", "abc"));
  assert(!(await keyMatches("abc", "abd")) && !(await keyMatches("ab", "abc")) && !(await keyMatches("", "abc")));
});

const SURVEY_URL = "https://fn.example.test/functions/v1/site-survey";
const answers = { q1: "one", q2: "two", q3: "three" };
const post = (body: unknown) =>
  new Request(SURVEY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

Deno.test("site-survey: a phone that is not on the waitlist is refused and nothing is written", async () => {
  const db = fakeDb({ site_waitlist: [{ phone: "+13125550123" }] });
  const h = createSurveyHandler({ env: env(), fetchFn: db.fetchFn });
  const r = await h(post({ name: "Eve", phone: "+13125559999", ...answers }));
  assertEquals(r.status, 403);
  assertEquals((await r.json()).error, "not on the waitlist");
  assertEquals(db.tables.site_waitlist_survey.length, 0);
  assert(db.calls.every((c) => c.method === "GET"));
});

Deno.test("site-survey: one survey per waitlist phone; the number typed by hand matches the stored form", async () => {
  const db = fakeDb({ site_waitlist: [{ phone: "+13125550123" }] });
  const h = createSurveyHandler({ env: env(), fetchFn: db.fetchFn });
  const first = await h(post({ name: "Ada", phone: "(312) 555-0123", ...answers, source: "https://x.test/survey?n=Ada&p=%2B13125550123" }));
  assertEquals(first.status, 200);
  assertEquals(db.tables.site_waitlist_survey.length, 1);
  const row = db.tables.site_waitlist_survey[0] as Record<string, unknown>;
  assertEquals(row.phone, "+13125550123");
  assertEquals(row.source, "/survey", "source is a path only");
  const again = await h(post({ name: "Ada", phone: "+13125550123", ...answers }));
  assertEquals(again.status, 409);
  assertEquals((await again.json()).error, "already answered");
  assertEquals(db.tables.site_waitlist_survey.length, 1, "the duplicate was not written");
});

Deno.test("site-survey: phone normalisation and source path", () => {
  assertEquals(waitlistPhone("+1 (312) 555-0123"), "+13125550123");
  assertEquals(waitlistPhone("312.555.0123"), "+13125550123");
  assertEquals(waitlistPhone("13125550123"), "+13125550123");
  assertEquals(waitlistPhone("+44 7700 900123"), "+447700900123");
  assertEquals(waitlistPhone("  "), "");
  assertEquals(sourcePath("/survey"), "/survey");
  assertEquals(sourcePath("https://trainee.example/survey?n=Ada&p=1#x"), "/survey");
  assertEquals(sourcePath(null), null);
});

Deno.test("pages: name and phone go to /survey through sessionStorage, never the URL", () => {
  for (const f of ["site/index.html", "docs/launch/legal-pages/home.template.html"]) {
    const h = read(f);
    assert(!/\/survey\?/.test(h), `${f} builds no /survey? URL`);
    assert(/sessionStorage\.setItem\('trainee-survey'/.test(h), `${f} hands the survey its identity in sessionStorage`);
  }
  const s = read("site/survey.html");
  assert(!/URLSearchParams|searchParams/.test(s), "survey.html reads no name or phone from the URL");
  assert(/sessionStorage\.getItem\('trainee-survey'\)/.test(s) && /sessionStorage\.removeItem\('trainee-survey'\)/.test(s), "it reads and clears sessionStorage");
  assert(/source: location\.pathname/.test(s) && !/location\.href/.test(s), "and sends the path only as source");
});
