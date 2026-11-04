// trainee-file serves with the person's CONFIRMED facts (round-3 review): the deployed deps carry `facts` from the same source as
// trainee-telegram, and the list page's Apply screens the posting against them. Fake admin and stores, no network.
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { signedIn, phonePost } from "./file-session-fakes.ts";
const A = signedIn();
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";

const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-10-28T12:00:00Z"), LIST = "0123456789";
const SECRET = "file-link-secret-0123456789-abcdef";
const env = { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot" } as Record<string, string>)[k] };
const hit = { job_id: "greenhouse:acme:1", company: "Co1", title: "Data Analyst", location: "Austin, TX", url: "https://boards.greenhouse.io/acme/jobs/1", pay: "$90k" };
const row = { job_id: hit.job_id, provider: "greenhouse", description: "<p>Build dashboards. We are unable to sponsor visas for this role.</p>", first_seen_at: "2026-10-27T12:00:00Z", posted_at: "2026-10-26T12:00:00Z", closed_at: null };

// An admin that answers only the account read the confirmed-facts source makes.
function adminWith(account: unknown, reads: string[] = []) {
  return { from(table: string) {
    const q: any = { select: () => q, eq: (c: string, v: string) => { reads.push(`${table}.${c}=${v}`); return q; }, maybeSingle: async () => ({ data: account == null ? null : { value: account }, error: null }) };
    return q;
  } };
}
function account(...facts: Record<string, unknown>[]) {
  const profile: any = CareerProfile.createProfile({});
  for (const f of facts) CareerProfile.addFact(profile, { needs_confirmation: false, status: "confirmed", ...f });
  return { memory: { profile } };
}
const sponsor = (value: "yes" | "no") => ({ kind: "eligibility", text: value === "yes" ? "Needs visa sponsorship" : "Does not need visa sponsorship", value, screen_key: "sponsorship", source: "screen_answer", evidence: ["x"] });

const where = { kind: "location", text: "Lives in Austin, TX", value: "Austin, TX", screen_key: "location", source: "screen_answer", evidence: ["x"] };
async function applyOnList(acct: unknown) {
  const reads: string[] = [];
  const kv = new Map<string, any>(), wants: string[] = [];
  const store = {
    async remember(u: string, r: string, job: any, s: string) { kv.set(`${u}|job|${r}`, { job, shownAs: s }); }, async recall(u: string, r: string) { return kv.get(`${u}|job|${r}`) ?? null; },
    async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|list|${id}`, refs); }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return [row]; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want(_u: string, job: any) { wants.push(job.job_id); return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; },
    async claimLink() { return true; },
  } as unknown as FileStore;
  const built = buildFileDeps(adminWith(acct, reads), env, () => NOW);
  const d = { ...built, ...A.deps, store };
  const v = jobViewOf(hit, row as any), ref = await refOf(U, v.job_id);
  await store.remember(U, ref, v, "text"); await store.rememberList(U, LIST, [ref]);
  const t = await A.tok(U, LIST, NOW);
  const res = await handleFile(new Request("https://x.example/f", await phonePost({ t, action: "apply", ref, tag: "none" }, SECRET)), d);
  return { built, text: await res.text(), wants, reads };
}

Deno.test("the deployed trainee-file deps carry the person's confirmed facts, read from the same account record as trainee-telegram", async () => {
  const reads: string[] = [];
  const d = buildFileDeps(adminWith(account(sponsor("yes")), reads), env, () => NOW);
  assert.equal(typeof d.facts, "function", "facts is wired");
  const facts = await d.facts!(U);
  assert.ok(facts.length > 0 && JSON.stringify(facts).includes("sponsorship"), JSON.stringify(facts));
  assert.ok(reads.includes("career_watch_kv.key=career:account") && reads.includes(`career_watch_kv.user_id=${U}`), reads.join(","));
});

Deno.test("an unconfirmed fact is not a confirmed fact", async () => {
  const d = buildFileDeps(adminWith(account({ ...sponsor("yes"), needs_confirmation: true, status: "draft" })), env, () => NOW);
  assert.equal(JSON.stringify(await d.facts!(U)).includes("sponsorship"), false);
});

Deno.test("list-page Apply screens with the confirmed facts: needs sponsorship + 'unable to sponsor' is not queued; does not need it is queued", async () => {
  const blocked = await applyOnList(account(where, sponsor("yes")));
  assert.deepEqual(blocked.wants, []);
  assert.ok(/sponsor/i.test(blocked.text.replace(/<script[\s\S]*?<\/script>/g, "")) && /Not queued/.test(blocked.text), "refused for the sponsorship knock-out, not for a missing fact");
  assert.ok(!/needs a fact/.test(blocked.text));
  const ok = await applyOnList(account(where, sponsor("no")));
  assert.deepEqual(ok.wants, [hit.job_id], ok.text.replace(/<style[\s\S]*?<\/style>/g,"").replace(/<[^>]+>/g, " ").replace(/\s+/g," ").slice(0,500) + " a person who does not need sponsorship is not stopped by the posting's no-sponsorship line");
});

Deno.test("index.ts serves with buildFileDeps (so facts cannot be dropped from the deployed function)", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/trainee-file/index.ts", import.meta.url));
  assert.ok(/buildFileDeps\(admin/.test(src));
});
