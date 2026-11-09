// "I want frontend internships that pay $30/hr" sent over iMessage, through the production chat handler (agent-chat
// handler-career.ts handleChat) on a real Postgres with the real supabase-js client (tests/flow): the reply is one or two plain
// sentences and the results page's link ALONE as its own message; the link opens (signed, one sign-in) a page built from the same
// database rows: roles listing $30/hr or more first, then "pay not listed", the $25/hr role left out, a black Apply on every card.
// Apply on a role with no prepared application queues it to be prepared (career_apply_wanted) and sends nothing.
// The same ask on Telegram or the web, and an ask with no pay floor, get the page too (owner, 2026-11-02: every channel).
// No model call, no network beyond the local double.
//
// Run: CI=true deno test -A --no-check [--import-map=tests/flow/supabase-npm.json] tests/architect/role-pay-results-handler.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { MARKDOWN } from "../../supabase/functions/_shared/role_pay.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = { "rp-1": "7b0f8f8e-6a43-4a49-9d2c-0000000a1001", "rp-2": "7b0f8f8e-6a43-4a49-9d2c-0000000a1002" };
const SECRET = "TEST-results-link-secret-0123456789abcdef", BASE = "https://trainee.example/file";
const NOW = Date.now(), DAY = 86400000, iso = (ms: number) => new Date(ms).toISOString();
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const T = { sanitizeResources: false, sanitizeOps: false };

// Four frontend internships on the live board: two list $30/hr or more, one lists $25/hr, one lists no pay.
const LIVE = [
  { id: "greenhouse:rpay:1", company: "TEST Pay Web", title: "Frontend Engineering Intern", location: "Chicago, IL", pay: null, d: "Build React and TypeScript components. Pay: $35 - $40 per hour." },
  { id: "greenhouse:rpay:2", company: "TEST Pay Design", title: "Frontend Intern", location: "Remote", pay: "$30/hr", d: "Ship UI features in JavaScript with our design team." },
  { id: "greenhouse:rpay:3", company: "TEST Pay Low", title: "Frontend Intern", location: "Chicago, IL", pay: null, d: "Frontend internship in JavaScript. $25/hr." },
  { id: "greenhouse:rpay:4", company: "TEST Pay Quiet", title: "Frontend Developer Intern", location: "Chicago, IL", pay: null, d: "Build web pages in JavaScript and CSS for our product." },
];
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
async function worldOnce() {
  if (handler) return;
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  for (const [i, p] of LIVE.entries()) {
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, pay, posted_at, first_seen_at, last_seen_at)
      values ('${p.id}', 'greenhouse', 'rpay', '${p.company}', '${p.title}', '${p.location}', 'https://boards.greenhouse.io/rpay/jobs/${i + 1}', '${p.d}', ${p.pay ? `'${p.pay}'` : "null"},
      '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW)}')`);
  }
  handler = await careerHandler(pg, PEOPLE);
}
// The environment is shared by every test file in a shard: each test sets what it needs and puts back what was there.
const ENV_KEYS = ["TRAINEE_FILE_LINK_SECRET", "TRAINEE_FILE_BASE_URL", "ANTHROPIC_API_KEY", "CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN"];
async function withEnv(fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE })) Deno.env.set(k, v);
  for (const k of ["CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN"]) Deno.env.delete(k);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the results page handler test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};

Deno.test({ name: "results (handler): iMessage 'frontend internships that pay $30/hr' -> two plain sentences and the link alone; the page holds the rows by pay; Apply queues nothing to send", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(async () => {
  const person = PEOPLE["rp-1"], chat = handler!.chat("rp-1");
  assert((await chat.say(`here is my resume:\n${RESUME}`, { channel: "imessage" })).status === 200);
  assert((await chat.say("yes, that's my resume", { channel: "imessage" })).status === 200);
  const t = await chat.say("I want frontend internships that pay $30/hr", { channel: "imessage" });
  eq(t.status, 200, t.reply);
  // The reply shape.
  // Architect ruling (R10 fix 8, 2026-11-09; spec B.2): the sentences, then the roles by number (employer, exact title, location,
  // one-word check state), then the link alone as its own message.
  const lines = t.reply.split("\n");
  eq(lines.length, 5, t.reply);
  eq(lines[0], "I found 2 frontend internships that list pay of $30/hr or more, plus 1 that doesn't list pay, so I couldn't check it. Here they are by fit, with Apply on each.");
  assert(lines.slice(1, 4).every((l, i) => new RegExp(`^${i + 1}\\. TEST Pay \\w+ — [^()]+, [^()]+ \\((?:open-checked|not re-checked)\\) https://\\S+$`).test(l)), t.reply);
  eq(t.body.parts, [lines.slice(0, 4).join("\n"), lines[4]], "sent as two messages: the sentences with the numbered roles, then the link alone");
  assert(/^https:\/\/trainee\.example\/file\?t=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(lines[4]), `the link alone on its own line: ${lines[4]}`);
  assert(!MARKDOWN.test(t.reply), "no markdown on iMessage");
  assert(!/Pay \$|listed on the posting/.test(lines.slice(1, 4).join("\n")), "the numbered lines are short: no pay, no posting text (each carries its posting link, E.2 #18)");
  // The page: the link opens a sign-in (one per link); a session for this account then reads the list from the database.
  const link = new URL(lines[4]).searchParams.get("t")!;
  const claims = await verifyFileToken(link, SECRET, Date.now());
  assert(claims.ok && claims.claims.u === person && claims.claims.k === "l");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const A = signedIn();
  const d = { ...buildFileDeps(admin, { get: (k: string) => Deno.env.get(k) }, Date.now), ...A.deps };
  const preview = await handleFile(new Request(lines[4], { headers: { "user-agent": "facebookexternalhit/1.1 Facebot Twitterbot/1.0" } }), d);
  assert(!/TEST Pay/.test(await preview.text()), "a link preview shows nothing about the roles");
  const s = await A.tok(person, claims.ok ? claims.claims.r : "", Date.now());
  const page = await handleFile(new Request(`${BASE}`, { headers: { cookie: `tf_s=${s}` } }), d);
  eq(page.status, 200);
  const html = await page.text(), p = plain(html);
  assert(/Frontend internships, \$30\/hr or more/.test(p), p);
  assert(/Lists \$30\/hr or more \(2\)[\s\S]*TEST Pay (Web|Design)[\s\S]*TEST Pay (Web|Design)[\s\S]*Pay not listed \(1\)[\s\S]*TEST Pay Quiet/.test(p), p);
  assert(/Pay \$35-40\/hr · listed on the posting/.test(p) && /Pay \$30\/hr · listed on the posting/.test(p), p);
  assert(/TEST Pay Quiet Pay Pay not listed/.test(p), "no pay invented");
  assert(!/TEST Pay Low/.test(p), "the $25/hr role is left out");
  eq((html.match(/class="apply" aria-label="Apply to /g) ?? []).length, 3);
  // Apply on a role with no prepared application: queued to be prepared, nothing to send, nothing approved.
  const ref = html.split('<li class="card" id="r-').slice(1).find((c) => c.includes("TEST Pay Quiet"))!.slice(0, 12);
  const r = await handleFile(new Request(BASE, await phonePost({ t: s, action: "apply", ref, tag: "none" }, SECRET)), d);
  assert(/Getting your application ready\. Nothing is sent until you check it here and tap Apply/.test(plain(await r.text())));
  eq(await pg!.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`), "1");
  eq(await pg!.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`), "0", "nothing approved, nothing queued to send");
  });
} });

Deno.test({ name: "results (handler): the same ask on Telegram or the web, and an ask with no pay floor, get the page link alone as its own message", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(async () => {
  const chat = handler!.chat("rp-2");
  for (const [said, channel] of [["I want frontend internships that pay $30/hr", "telegram"], ["I want frontend internships that pay $30/hr", undefined], ["find me 10 frontend internship roles", "imessage"]] as const) {
    const t = await chat.say(said, channel ? { channel } : {});
    eq(t.status, 200);
    const parts = t.body.parts as string[];
    assert(Array.isArray(parts) && parts.length === 2, `${channel ?? "web"}: ${t.reply}`);
    // Architect ruling (R10 E.2 #18): each numbered role carries its posting link; the File link is its own message.
    assert(/^https:\/\/trainee\.example\/file\?t=v1\./.test(parts[1]) && !/trainee\.example\/file/.test(parts[0]), `${channel ?? "web"}: the File link is its own message`);
    // Architect ruling (R10 fix 8): the roles by number, short (no pay, no posting text), no markdown.
    const listed = parts[0].split("\n").slice(1);
    assert(listed.length >= 1 && listed.every((l, i) => l.startsWith(`${i + 1}. `) && /\((?:open-checked|not re-checked)\) https:\/\/\S+$/.test(l) && !/Pay \$/.test(l)) && !MARKDOWN.test(t.reply), `${channel ?? "web"}: numbered short roles with their links, no markdown: ${t.reply}`);
  }
  });
} });
