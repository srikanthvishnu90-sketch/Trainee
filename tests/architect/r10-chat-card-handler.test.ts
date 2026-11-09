// R10 spec C.2 (D-049), through the production chat handler (agent-chat handler-career.ts handleChat) on a real Postgres with the
// real supabase-js client (tests/flow): with CAREER_FILE_CARD=on, a role ask's results File answers as ONE File card. Telegram: the
// sentences, then the card in meta.file_card (its link rides the inline button; no link in any words). iMessage and the app: the
// card's words with the plain link as the last line. The link is the same signed results link. No model call, no network.
//
// Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/r10-chat-card-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { MARKDOWN } from "../../supabase/functions/_shared/role_pay.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = { "fc-1": "7b0f8f8e-6a43-4a49-9d2c-0000000a2001", "fc-2": "7b0f8f8e-6a43-4a49-9d2c-0000000a2002" };
const SECRET = "TEST-results-link-secret-0123456789abcdef", BASE = "https://trainee.example/file";
const NOW = Date.now(), DAY = 86400000, iso = (ms: number) => new Date(ms).toISOString();
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const T = { sanitizeResources: false, sanitizeOps: false };

// Four frontend internships on the live board: two list $30/hr or more, one lists $25/hr, one lists no pay.
const LIVE = [
  { id: "greenhouse:fcard:1", company: "TEST Card Web", title: "Frontend Engineering Intern", location: "Chicago, IL", pay: null, d: "Build React and TypeScript components. Pay: $35 - $40 per hour." },
  { id: "greenhouse:fcard:2", company: "TEST Card Design", title: "Frontend Intern", location: "Remote", pay: "$30/hr", d: "Ship UI features in JavaScript with our design team." },
  { id: "greenhouse:fcard:3", company: "TEST Card Low", title: "Frontend Intern", location: "Chicago, IL", pay: null, d: "Frontend internship in JavaScript. $25/hr." },
  { id: "greenhouse:fcard:4", company: "TEST Card Quiet", title: "Frontend Developer Intern", location: "Chicago, IL", pay: null, d: "Build web pages in JavaScript and CSS for our product." },
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
      values ('${p.id}', 'greenhouse', 'fcard', '${p.company}', '${p.title}', '${p.location}', 'https://boards.greenhouse.io/fcard/jobs/${i + 1}', '${p.d}', ${p.pay ? `'${p.pay}'` : "null"},
      '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW)}')`);
  }
  handler = await careerHandler(pg, PEOPLE);
}
// The environment is shared by every test file in a shard: each test sets what it needs and puts back what was there.
const ENV_KEYS = ["TRAINEE_FILE_LINK_SECRET", "TRAINEE_FILE_BASE_URL", "ANTHROPIC_API_KEY", "CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN", "CAREER_FILE_CARD"];
async function withEnv(fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, CAREER_FILE_CARD: "on" })) Deno.env.set(k, v);
  for (const k of ["CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN"]) Deno.env.delete(k);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the results page handler test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};

Deno.test({ name: "C.2 card (handler): Telegram gets the sentences and ONE File card whose signed link rides only the button", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(async () => {
    const person = PEOPLE["fc-1"], chat = handler!.chat("fc-1");
    assert((await chat.say(`here is my resume:\n${RESUME}`, { channel: "telegram" })).status === 200);
    assert((await chat.say("yes, that's my resume", { channel: "telegram" })).status === 200);
    const t = await chat.say("I want frontend internships that pay $30/hr", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[], card = (t.body.meta as Record<string, any>).file_card;
    assert(card && typeof card.url === "string", `a card: ${JSON.stringify(t.body.meta)}`);
    assert(parts.every((p) => !/https?:\/\//.test(p)), `no link in any message's words: ${JSON.stringify(parts)}`);
    assert(!/https?:\/\//.test(t.reply) && !/https?:\/\//.test(card.text), "the link rides only the button");
    assert(/^ROLES FILE\nFrontend internships\nUpdated .+ - \d+ roles? found/.test(card.text), card.text);
    assert(/nothing is submitted from chat\.$/.test(card.text));
    eq(card.label, "Open the File");
    const claims = await verifyFileToken(new URL(card.url).searchParams.get("t")!, SECRET, Date.now());
    assert(claims.ok && claims.claims.u === person && claims.claims.k === "l", "the button opens this person's signed results link");
    assert(!/TEST Card/.test(t.reply) && !MARKDOWN.test(t.reply), "no wall of postings, no markdown");
  });
} });

Deno.test({ name: "C.2 card (handler): iMessage and the app get the card's words with the plain link as the last line; off, the link alone as before", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(async () => {
    const chat = handler!.chat("fc-2");
    assert((await chat.say(`here is my resume:\n${RESUME}`, { channel: "imessage" })).status === 200);
    assert((await chat.say("yes, that's my resume", { channel: "imessage" })).status === 200);
    for (const channel of ["imessage", undefined] as const) {
      const t = await chat.say("I want frontend internships that pay $30/hr", channel ? { channel } : {});
      eq(t.status, 200);
      const parts = t.body.parts as string[], last = parts.at(-1)!;
      assert(!(t.body.meta as Record<string, unknown>).file_card, "no button card off Telegram");
      assert(/^ROLES FILE\nFrontend internships\n/.test(last) && /\nhttps:\/\/trainee\.example\/file\?t=v1\.\S+$/.test(last), `${channel ?? "web"}: ${last}`);
      eq((t.reply.match(/https:\/\//g) ?? []).length, 1, "one card, one link");
    }
    Deno.env.delete("CAREER_FILE_CARD");
    const off = await chat.say("I want frontend internships that pay $30/hr", { channel: "imessage" });
    const op = off.body.parts as string[];
    assert(/^https:\/\/trainee\.example\/file\?t=v1\./.test(op.at(-1)!) && !/ROLES FILE/.test(off.reply), "off: the link alone, as before");
  });
} });
