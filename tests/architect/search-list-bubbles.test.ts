// SEARCH LISTS (2026-11-01, texting): a found list fits in at most three text bubbles on iMessage (where every link is its own
// message when a reply carries two or fewer): the summary carries the next step, each role is one short line (title, company,
// where, the posting's own pay) with its link alone on the next line, and nothing comes after the last link. Live path
// (evals/career/world.ts) and the iMessage adapter's own render (channel_registry.ts), texting voice on and off.
import assertNode from "node:assert/strict";
import { openWorld, worldTurn } from "../../evals/career/world.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { findUrls } from "../../supabase/functions/_shared/channel_text.ts";
import { CareerReply } from "../../supabase/functions/_shared/router_core.career.js";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const refuse = (async () => { throw new TypeError("no network"); }) as unknown as typeof fetch;
const imessage = (native: boolean) => {
  const env: Record<string, string> = { LOOPMESSAGE_API_KEY: "k", CAREER_TEXTING_NATIVE: native ? "on" : "off" };
  return (adaptersFromEnv({ get: (k: string) => env[k] }, { fetch: refuse, clock: () => 0, sleep: async () => {} }) as any).imessage.render as (t: string) => string[];
};
const linkOnly = (b: string) => { const t = b.trim(); const u = findUrls(t); return u.length === 1 && u[0].start === 0 && u[0].end === t.length; };

async function search(message: string, profiled: boolean, postings = W.postings) {
  const w = await openWorld(profiled ? { now: W.now, postings, facts: W.facts, tracked: W.tracked } : { now: W.now, postings });
  return await worldTurn(w, { brain: "router", threadId: "A", message, now: w.now });
}

Deno.test("a list: summary with its next step, one line and one link per role, nothing after the last link", async () => {
  for (const [m, profiled] of [["find me data analyst jobs in chicago", false], ["find me jobs", true]] as const) {
    const r = await search(m, profiled);
    assertNode.equal(r.handler, "router:career_discovery", m);
    const lines = r.reply.split("\n");
    assertNode.match(lines[0], /^3 roles that (?:match your search|fit your profile best)\. .*[?.]$/, r.reply);
    assertNode.match(lines[0], /\?$|Reply with a number/, r.reply);
    assertNode.equal(lines.length, 7, r.reply);
    for (let i = 1; i < 7; i += 2) {
      assertNode.match(lines[i], new RegExp(`^${(i + 1) / 2}\\) [^\\n]+ at [^\\n]+, [^\\n]+$`), r.reply);
      assertNode.ok(linkOnly(lines[i + 1]), `${lines[i + 1]} is the role's link alone`);
    }
    assertNode.doesNotMatch(r.reply, /heads-up|matches your search;|closest to your profile|Tell me what you'd like to do next/);
  }
});

Deno.test("on iMessage the list is at most three text bubbles, voice on and off, with 1, 2 and 3 roles", async () => {
  // Brex, Notion and Figma ask for no years of experience (a person with nothing on file is screened on that, see below).
  const open = W.postings.filter((p: any) => /brex|notion|figma/i.test(p.company));
  const pools = [open.slice(0, 1), open.slice(0, 2), W.postings];
  for (const native of [true, false]) {
    for (const pool of pools) {
      const r = await search("find me data analyst jobs", false, pool);
      const bubbles = imessage(native)(r.reply);
      const text = bubbles.filter((b) => !linkOnly(b));
      assertNode.ok(text.length <= 3, `${native ? "on" : "off"}, ${pool.length} postings: ${text.length} text bubbles\n${bubbles.join("\n||\n")}`);
      // The last thing the phone shows is a role's link, never a closer after it.
      assertNode.ok(findUrls(bubbles.at(-1)!).length > 0, bubbles.at(-1));
    }
  }
});

Deno.test("pay is the posting's own figure, and a posting without one shows none", async () => {
  // A SYNTHETIC posting whose own text states a range (no salary field), beside Brex, which states none.
  const brex = W.postings.find((p: any) => /brex/i.test(p.company));
  const acme = { ...brex, job_id: "greenhouse:acme:7999999", company: "Acme Freight", url: "https://job-boards.greenhouse.io/acme/jobs/7999999", description: "Acme Freight is hiring a Data Analyst in Chicago. SQL and Excel. $80,000 - $95,000 a year." };
  const r = await search("find me data analyst jobs", false, [brex, acme]);
  assertNode.match(r.reply, /Data Analyst at Acme Freight, Chicago, \$80,000-\$95,000 a year\n/, r.reply);
  assertNode.match(r.reply, /Data Analyst at Brex, Chicago\n/, r.reply);
});

Deno.test("the ending guarantee still adds a next step to a reply that ends on a link without one", () => {
  const plain = "Here is the posting.\nhttps://job-boards.greenhouse.io/stripe/jobs/7001001";
  assertNode.notEqual(CareerReply.ensureNextStep(plain), plain);
  const listed = "2 roles that match your search. Want me to rank them against your resume?\n1) A, B, C\nhttps://x.example/1\n2) D, E, F\nhttps://x.example/2";
  assertNode.equal(CareerReply.ensureNextStep(listed), listed);
});
