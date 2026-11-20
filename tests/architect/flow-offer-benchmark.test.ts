// FEATURE 12 (DIAGNOSIS 2.13, fix F6): offers and negotiation backed by market numbers, through the REAL handler
// (handleChat) on real Postgres. The pay datasets are the WO-036 test fixtures (tests/fixtures/career-pay, invented rows
// built by the real importers; never DOL or BLS data), set on the offer turn's data source; the posted pay ranges are
// career_postings rows as the ingest writes them (the board's own pay field). Then a person's words: an offer, a second
// offer whose employer filed too few wages for a median (the n < 5 refusal), rate checks with and without enough
// postings, "compare my two offers", "help me negotiate" (the counter on a card citing the benchmark, nothing sent), a
// half-told offer asked once, and a plain "I got an offer!" left to the router.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { payData } from "../../supabase/functions/_shared/career_offer.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-f": "7b0f8f8e-6a43-4a49-9d2c-0000000000f1", "tok-g": "7b0f8f8e-6a43-4a49-9d2c-0000000000f2" };
const root = new URL("../../", import.meta.url);
const readJson = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));

Deno.test({ name: "FEATURE 12: offers placed against market numbers at the real handler; n < 5 refused; the counter cites the benchmark on a card", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  // The fixture datasets, on the same module instance the handler imports. Before this feature the module does not
  // exist and the router answers every turn (the fail-first run).
  const fixtures = { ...payData(), lca_wages: await readJson("tests/fixtures/career-pay/lca-wages.fixture.json"), oews_metro: await readJson("tests/fixtures/career-pay/oews-metro.fixture.json") };
  const mod: any = await import("../../supabase/functions/_shared/career_offer_chat.ts").catch(() => null);
  if (mod?.offerData) mod.offerData.get = () => fixtures;
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    // Six open Data Analyst postings in Chicago that state a yearly range (midpoints 90k..120k), one hourly and one in New
    // York (both left out), and two Product Manager postings in Denver (too few for a median).
    const posting = (i: number, title: string, location: string, pay: string | null, closed = false) =>
      `('greenhouse:f12:${i}', 'greenhouse', 'f12', 'Employer ${i}', '${title}', '${location}', 'https://boards.greenhouse.io/f12/jobs/${i}', '${title}. SQL and dashboards.', ${pay ? `'${pay}'` : "null"}, now(), now(), ${closed ? "now()" : "null"})`;
    const rows = [
      ...[120000, 100000, 90000, 110000, 95000, 105000].map((m, i) => posting(i + 1, "Data Analyst", "Chicago, IL", `$${(m - 10000).toLocaleString("en-US")}–$${(m + 10000).toLocaleString("en-US")} (Base salary)`)),
      posting(7, "Data Analyst", "Chicago, IL", "$40–$55 per hour"), posting(8, "Data Analyst", "New York, NY", "$200,000–$220,000"),
      posting(9, "Data Analyst", "Chicago, IL", "$300,000–$320,000", true),
      posting(10, "Product Manager", "Denver, CO", "$140,000–$170,000"), posting(11, "Product Manager", "Denver, CO", "$150,000–$180,000"),
    ];
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, pay, first_seen_at, last_seen_at, closed_at) values ${rows.join(",\n")};`);
    handler = await careerHandler(pg, PEOPLE);
    const chat: Chat = handler.chat("tok-f");
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    // Architect amendment (owner decision 2026-11-13, D-078: confirm before compare): the handler shows its reading of an offer or
    // rate check first and compares nothing until the person's plain yes to it; `told` is the message, the reading shown (checked),
    // and the person's "yes" through the same real handler. Every assertion below is on the reply after that yes, unchanged.
    const told = async (c: Chat, message: string) => {
      const shown = await say(c, message);
      if (shown.intent !== "career_offer_confirm") return shown;
      assert(/Is that right\? Reply yes, or tell me what to change\./.test(shown.reply) && !/median|percentile/.test(shown.reply), shown.reply);
      return say(c, "yes");
    };
    const noNumber = (reply: string, n: string) => assert(!reply.includes(n), `a median from too few filings is never said (${n}): ${reply}`);

    await t.step("an offer: the employer's own filings (n = 5) and BLS, each with its median, the offer's percentile, n, dataset and period", async () => {
      const r = await told(chat, "I got an offer from JPMorgan for $110k base plus a $10k signing bonus as an analyst in New York, with $20k in RSUs over 4 years. Need to answer by Friday");
      eq(r.intent, "career_offer_benchmark", r.reply);
      assert(/JPMorganChase's own H-1B filings for Financial and Investment Analysts in the New York metro \(DOL H-1B LCA, FIXTURE Q0\): median \$120,000, from 5 filings/.test(r.reply), r.reply);
      assert(/Your base is at exactly the 25th percentile/.test(r.reply), r.reply);
      assert(/\(BLS OEWS, FIXTURE May 0000\): median \$120,000, about 60,000 people employed; middle half \$90,000 to \$160,000\. Your base is at about the 42nd percentile \(estimated between the published 25th and 50th\)/.test(r.reply), r.reply);
      assert(/signing \$10,000/.test(r.reply) && /Equity as you said it: \$20k in RSUs over 4 years \(not valued\)/.test(r.reply) && /Deadline: Friday/.test(r.reply), r.reply);
      assert(Array.isArray(r.body.parts) && r.body.parts.every((p: string) => p.length <= 1500), "each message fits a text");
    });

    await t.step("n < 5: the employer filed 4 wages, so no median is stated and the reply says why; BLS still places it", async () => {
      const r = await told(chat, "Goldman offered me $95,000 in New York as a summer analyst");
      eq(r.intent, "career_offer_benchmark", r.reply);
      assert(/Goldman Sachs's own H-1B filings for Financial and Investment Analysts in the New York metro: no median, only 4 filings in FIXTURE Q0, too few for a median/.test(r.reply), r.reply);
      noNumber(r.reply, "$117,820");
      assert(/BLS OEWS, FIXTURE May 0000\): median \$120,000/.test(r.reply) && /at about the 29th percentile/.test(r.reply), r.reply);
    });

    await t.step("a rate check with no company: the pay six open postings in the metro state, the closed, hourly and other-city ones left out", async () => {
      const r = await told(chat, "is $95k good for a data analyst in Chicago");
      eq(r.intent, "career_offer_benchmark", r.reply);
      assert(/^Checking: data analyst, Chicago metro, base \$95,000\./.test(r.reply), r.reply);
      assert(/Public pay data \(DOL, BLS\): none mapped to "data analyst", so no public figure/.test(r.reply), r.reply);
      assert(/Pay stated by open data analyst postings in the Chicago metro on file: median \$102,500 from 6 postings/.test(r.reply), r.reply);
      assert(/Your base is above the middle of 1 of the 6 posted ranges/.test(r.reply), r.reply);
      const again = await told(chat, "Is 130k a fair salary for a data analyst in Chicago?");
      assert(/above the middle of 6 of the 6 posted ranges/.test(again.reply), again.reply);
    });

    await t.step("a rate check with two postings: no number, and the reason", async () => {
      const r = await told(chat, "is $150k good for a product manager in Denver");
      eq([r.intent, r.resultStatus], ["career_offer_benchmark", "no_benchmark"], r.reply);
      assert(/only 2 open postings on file state a yearly pay range, too few for a median \(I need at least 5\)/.test(r.reply), r.reply);
      assert(/I have no market number for this one, and I won't make one up/.test(r.reply), r.reply);
      noNumber(r.reply, "$155,000"); noNumber(r.reply, "$160,000");
    });

    await t.step("compare my two offers: side by side as stated, each against its benchmark; no cost-of-living adjustment invented", async () => {
      const r = await say(chat, "compare my two offers");
      eq(r.intent, "career_offer_compare", r.reply);
      for (const w of [/Base: JPMorganChase \$110,000; Goldman Sachs \$95,000\./, /Signing: JPMorganChase \$10,000; Goldman Sachs not given\./,
        /Equity: JPMorganChase \$20k in RSUs over 4 years \(as you said it, not valued\); Goldman Sachs not given\./, /Deadline: JPMorganChase Friday; Goldman Sachs not given\./,
        /First-year cash \(base, signing and a stated bonus amount\): JPMorganChase \$120,000; Goldman Sachs \$95,000\./, /Cost of living: same place/]) assert(w.test(r.reply), `${w}: ${r.reply}`);
      assert(/Goldman Sachs median \$120,000 \(BLS OEWS/.test(r.reply), `Goldman is placed on BLS, not on its 4 filings: ${r.reply}`);
    });

    await t.step("help me negotiate: the counter cites the median and n, on a card bound to its exact text; nothing is sent", async () => {
      const r = await say(chat, "help me negotiate the JPMorgan offer");
      eq([r.intent, r.resultStatus], ["career_offer_counter", "drafted"], r.reply);
      assert(/shows a median of \$120,000\./.test(r.reply) && /DOL LCA, FIXTURE Q0, 5 filings/.test(r.reply), r.reply);
      assert(/Could you bring the base closer to \$120,000\?/.test(r.reply) && /I'll get back to you by Friday\./.test(r.reply), r.reply);
      assert(/Nothing is sent/.test(r.reply), r.reply);
      const card = r.body.meta?.offer_card;
      assert(card && card.type === "approval_card" && card.kind === "counter_email" && card.requires_approval === true && card.sent === false, JSON.stringify(r.body.meta));
      assert(card.body.includes("shows a median of $120,000") && r.reply.includes(card.body), "the card holds the exact email shown");
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(card.body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      eq(card.payload_hash, h, "the card is bound to its text");
      const sent = await pg.sql(`select count(*) from public.career_outbox`).catch(() => "0");
      assert(/\b0\b/.test(sent), `nothing queued to send: ${sent}`);
    });

    await t.step("a half-told offer is asked once; the answer completes it", async () => {
      const ask = await say(chat, "Stripe offered me 150k");
      eq(ask.intent, "career_offer_ask", ask.reply);
      assert(/I need the city and the job title/.test(ask.reply), ask.reply);
      const r = await told(chat, "software engineer in Seattle");
      eq(r.intent, "career_offer_benchmark", r.reply);
      assert(/Stripe's own H-1B filings for Software Developers in the Seattle metro: no median, only 1 filing in FIXTURE Q0, too few for a median/.test(r.reply), r.reply);
      noNumber(r.reply, "$170,000");
      assert(/BLS pay for Software Developers in the Seattle metro: no median, the median is above BLS's top published band/.test(r.reply), r.reply);
    });

    await t.step("not an offer turn: a plain 'I got an offer!' and a job search go to the router; another person has no offers on file", async () => {
      const plain = await say(chat, "I got an offer from Acme!");
      assert(!String(plain.intent).startsWith("career_offer_"), `${plain.intent}: ${plain.reply}`);
      const find = await say(chat, "find data analyst jobs in Chicago");
      assert(!String(find.intent).startsWith("career_offer_"), `${find.intent}: ${find.reply}`);
      const other = handler!.chat("tok-g");
      const r = await say(other, "compare my two offers");
      eq(r.intent, "career_offer_compare", r.reply);
      assert(/I have no offers on file in this chat yet/.test(r.reply) && !/JPMorgan|Goldman/.test(r.reply), r.reply);
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
