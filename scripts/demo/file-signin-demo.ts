// A local demo of the trainee-file sign-in and Apply flow on TEST DATA (owner, 2026-10-29). The real handler
// (supabase/functions/trainee-file/handler.ts) over memory stores: no database, no SMS (the "texted" code is printed here and
// at /demo/last-code), no model, no real application. Run:
//   deno run -A --no-check scripts/demo/file-signin-demo.ts [port]
// then open http://localhost:<port>/demo/link (a fresh link for the test person; /demo/link?who=v for the second test account).
// The test person's phone is +1 512 555 0100; the second account's is +1 512 555 0199.
// A copied page is not a session: after signing in, view the page's source and copy the value of any hidden `t` input (a page
// token, never the session id; the id is only in the HttpOnly cookie), then open /demo/replay?t=<that value> (or run
// `curl -s -X POST -d 't=<value>&action=refresh' http://127.0.0.1:<port>/file`): the same form posted without the browser's cookie
// is refused with "Sign in on this device", and nothing about the jobs is in the answer.
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { fakePhone, memSessions } from "../../tests/architect/file-session-fakes.ts";

const port = Number(Deno.args[0] ?? 8787);
const SECRET = "demo-link-secret-not-a-real-secret-0123";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const LIST = "0123456789", LIST_V = "9876543210", H = "ab".repeat(32);
const JOBS = [
  { company: "Ramp", domain: "ramp.com", title: "Data Analyst, Growth", location: "New York, NY", pay: "$110k-$135k", text: "Own the weekly growth dashboards and the experiment readouts for card acquisition." },
  { company: "Figma", domain: "figma.com", title: "Business Analyst", location: "San Francisco, CA", pay: "$120k-$150k", text: "Partner with sales leadership on pipeline models and quarterly planning." },
  { company: "Stripe", domain: "stripe.com", title: "Analytics Associate", location: "Remote (US)", pay: null, text: "Build the metrics layer for a new payments product and answer the questions it raises." },
  { company: "Notion", domain: "notion.so", title: "Product Analyst", location: "Austin, TX", pay: "$105k-$125k", text: "Measure how teams adopt new features and turn the findings into roadmap calls." },
];
const id = (n: number) => `greenhouse:demo:${n}`;
const pid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const kv = new Map<string, any>(), apps = new Map<string, AppRow>();
const num = (j: string) => Number(j.split(":").pop());
const post = (n: number) => ({ job_id: id(n), provider: "greenhouse", company_domain: JOBS[n - 1].domain,
  description: `<p>${JOBS[n - 1].text}</p><p>What you'll need</p><ul><li>3+ years of SQL</li><li>Comfort presenting to leadership</li></ul>`, location: JOBS[n - 1].location, pay: JOBS[n - 1].pay });
const prepared = (n: number): PreparedRow => ({ id: pid(n), job_id: id(n), company: JOBS[n - 1].company, url: `https://boards.greenhouse.io/demo/jobs/${n}`, payload_hash: H, state: "ready", card_lines: [],
  payload: { resume_sha256: "f".repeat(64), resume_name: "test-person-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Test" }, { name: "last_name", label: "Last name", value: "Person" }, { name: "email", label: "Email", value: "test.person@example.test" }] } });
const store: FileStore = {
  async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
  async recall(u, ref) { return kv.get(`${u}|job|${ref}`) ?? null; },
  async rememberList(u, l, refs) { kv.set(`${u}|list|${l}`, refs); },
  async recallList(u, l) { return kv.get(`${u}|list|${l}`) ?? null; },
  async postings(ids) { return ids.map((j) => post(num(j))) as any; },
  async save() { return "saved"; },
  async prepared(u, j) { return u === U && num(j) !== 4 && !apps.has(j) ? prepared(num(j)) : null; },
  async applied(u, j) { return u === U && apps.has(j); },
  async want(_u, _job) { return { result: "queued" }; },
  async appRow(u, j) { return u === U ? apps.get(j) ?? null : null; },
  async wanted() { return false; },
};
const refs: string[] = [];
for (let i = 1; i <= JOBS.length; i++) {
  const v = jobViewOf({ job_id: id(i), company: JOBS[i - 1].company, title: JOBS[i - 1].title, location: JOBS[i - 1].location, url: `https://boards.greenhouse.io/demo/jobs/${i}`, pay: JOBS[i - 1].pay ?? undefined }, post(i) as any);
  const r = await refOf(U, v.job_id); refs.push(r); await store.remember(U, r, v, "text");
}
await store.rememberList(U, LIST, refs);
{ const v = jobViewOf({ job_id: id(9), company: "Other Account Co", title: "Their Job", url: "https://boards.greenhouse.io/demo/jobs/9" }, null); const r = await refOf(V, v.job_id); await store.remember(V, r, v, "text"); await store.rememberList(V, LIST_V, [r]); }
const S = memSessions();
const P = fakePhone({ [U]: "+15125550100", [V]: "+15125550199" });
let current = 1;
const tap: TapStore = {
  async card(_u, cid) { return { id: cid, items: [{ n: 1, prepared_id: pid(current), payload_hash: H }], state: "open", user_id: U } as any; },
  async prepared() { return [{ id: pid(current), payload_hash: H, company: JOBS[current - 1].company }]; },
  async answer(_u, _card, approve) {
    const j = id(current);
    if (apps.has(j)) return [{ n: 1, company: JOBS[current - 1].company, result: "duplicate" }];
    if (approve.length) apps.set(j, { id: `j${current}`, state: "queued", reason: null, confirmation_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), email_confirmed_at: null, payload: {}, company: JOBS[current - 1].company, url: `https://boards.greenhouse.io/demo/jobs/${current}` });
    return [{ n: 1, company: JOBS[current - 1].company, result: approve.length ? "queued" : "declined" }];
  },
};
const env: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `https://trainee.example/file`, TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
const d: FileDeps = { store, now: () => Date.now(), env: { get: (k) => env[k] }, sessions: S.store, phone: P.auth, userOfTelegram: async () => null,
  cards: { async open(_u, ids) { current = Number(ids[0].split("-").pop()); return { id: "44444444-4444-4444-8444-444444444444", items: [{ n: 1, prepared_id: ids[0], payload_hash: H }], shown_at: new Date().toISOString() }; } },
  tap };

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/demo/link") {
    const v = u.searchParams.get("who") === "v";
    const t = (await mintFileToken({ secret: SECRET, userId: v ? V : U, list: v ? LIST_V : LIST, now: Date.now(), kind: "l" }))!;
    return Response.redirect(`${u.origin}/file?t=${encodeURIComponent(t)}`, 302);
  }
  if (u.pathname === "/demo/last-code") return new Response(P.lastCode(), { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  if (u.pathname === "/demo/texts") return Response.json(P.texts);
  if (u.pathname === "/demo/replay") {
    // The page's form replayed from "another browser": the same fields, no cookie.
    const r = await handleFile(new Request(`${u.origin}/file`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: u.origin, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ t: u.searchParams.get("t") ?? "", action: "refresh" }).toString() }), d);
    const body = await r.text();
    const title = /<h1>([^<]*)<\/h1>/.exec(body)?.[1] ?? "";
    return Response.json({ status: r.status, page: title, shows_jobs: JOBS.some((j) => body.includes(j.company)) });
  }
  if (u.pathname !== "/file") return new Response("not found", { status: 404 });
  const r = await handleFile(req, d);
  if (P.texts.length) console.log(`(demo) last code texted to ${P.texts.at(-1)!.phone}: ${P.lastCode()}`);
  return r;
});
console.log(`trainee-file demo on http://127.0.0.1:${port}/demo/link (test data; nothing real is sent)`);
