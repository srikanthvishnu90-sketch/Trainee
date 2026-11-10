// x-audit (2026-11-10, coordinator ruling (4)): the jobs page's single-use link cannot be burned by a link scanner. A GET
// of the link only begins a phone sign-in for that browser; the link is spent only when a code texted to the account's own
// phone is typed back (trainee-file/handler.ts). So any number of scanner fetches, including ones that look exactly like a
// browser and follow the redirect, leave the person's own tap working, and send no text.
// Memory stores, a fake clock and a fake text message: no network, no database.
// Run: deno test -A --no-check tests/architect/x-audit-file-link-scanners.test.ts
import assertNode from "node:assert/strict";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests";
const U = "11111111-1111-4111-8111-111111111111", U_PHONE = "+15125550100", LIST = "0123456789";
const NOW = Date.parse("2026-11-10T15:00:00Z");

async function world() {
  const kv = new Map<string, unknown>();
  const store = {
    async remember(u: string, ref: string, job: unknown, shownAs: string) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u: string, ref: string) { return kv.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|list|${id}`, refs); },
    async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return [{ job_id: "greenhouse:co:1", provider: "greenhouse", company_domain: "acme.com", description: "<p>Build dashboards.</p>" }]; },
    async save() { return "saved"; },
    async prepared() { return null; },
    async applied() { return false; },
    async want() { return { result: "queued" }; },
    async appRow() { return null; },
    async wanted() { return false; },
  } as unknown as FileStore;
  const v = jobViewOf({ job_id: "greenhouse:co:1", company: "Acme", title: "Data Analyst 1", location: "Austin, TX", url: "https://boards.greenhouse.io/co/jobs/1", pay: "$90k" } as never,
    { job_id: "greenhouse:co:1", provider: "greenhouse", company_domain: "acme.com", description: "<p>Build dashboards.</p>" } as never);
  const r = await refOf(U, v.job_id);
  await store.remember(U, r, v, "text");
  await store.rememberList(U, LIST, [r]);
  const S = memSessions(), P = fakePhone({ [U]: U_PHONE });
  const env: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
  const d = { store, now: () => NOW, env: { get: (k: string) => env[k] }, sessions: S.store, phone: P.auth, userOfTelegram: async () => null,
    cards: { async open() { throw new Error("no card in this test"); } }, tap: {} } as unknown as FileDeps;
  return { d, S, P, link: async () => (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW, kind: "l" }))! };
}

// A client with its own cookie jar; a scanner is a fresh one per fetch, the person's phone is one throughout.
function client(d: FileDeps, ua: string) {
  const jar = new Map<string, string>();
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv, ...a] = c.split(";"); const [k, v] = kv.split("="); if (a.some((x) => /Max-Age=0/i.test(x))) jar.delete(k.trim()); else jar.set(k.trim(), v); } return r; };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    jar,
    req: async (path: string, method = "GET") => take(await handleFile(new Request(`https://trainee.example${path}`, { method, headers: { cookie: cookie(), "user-agent": ua } }), d)),
    post: async (f: Record<string, string>) => take(await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { cookie: cookie(), "user-agent": ua, origin: "https://trainee.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), d)),
  };
}

const SCANNERS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1", "Mozilla/5.0 SafeLinks", "Microsoft Office Protocol Discovery", "curl/8.0", ""];

Deno.test("25 scanner fetches of the link (browser-looking ones included, each following the redirect) send no text and leave the person's own sign-in working", async () => {
  const w = await world();
  const link = await w.link(), path = `/file?t=${encodeURIComponent(link)}`;
  let fetches = 0;
  for (let i = 0; i < 25; i++) {
    const s = client(w.d, SCANNERS[i % SCANNERS.length]);
    const method = i % 5 === 4 ? "HEAD" : "GET";
    const r = await s.req(path, method);
    fetches++;
    if (r.status === 303 && r.headers.get("location")) { await s.req(r.headers.get("location")!); fetches++; }
    eq(s.jar.has("tf_s"), false, "a scanner never holds a session");
  }
  eq(w.P.texts.length, 0, "no scanner fetch sends a code");
  // The person, afterwards, on their own phone.
  const me = client(w.d, SCANNERS[1]);
  eq((await me.req(path)).status, 303, "the link still opens the sign-in");
  eq((await me.post({ action: "phone_start", phone: "(512) 555-0100" })).status, 200);
  eq(w.P.texts.map((t: { phone: string }) => t.phone), [U_PHONE], "one text, to the account's own phone");
  const ok = await me.post({ action: "phone_verify", code: w.P.lastCode() });
  eq(ok.status, 303, "the code signs the person in");
  eq(me.jar.has("tf_s"), true);
  const feed = await me.req("/file");
  eq(feed.status, 200);
  eq((await feed.text()).includes("Acme"), true, "the person's own list");
  console.log(`scanner fetches: ${fetches}; texts sent by them: 0; person's sign-in after them: ok`);
});
