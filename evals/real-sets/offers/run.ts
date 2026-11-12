// REAL SET, item 13 (offer math; VERIFICATION-15 "The 95% bars", D-068): 27 real public pay figures (figures.json, hand-labelled
// from the recorded postings) -> 27 comparisons, each checked exactly. A fictional asker tells Trainee about two offers: one at
// this figure's posted low, one at the next employer's posted high plus a $10,000 signing bonus, then asks to compare. Through
// the real offer turn (career_offer_chat.ts offerChatTurn, the one handleChat calls), with the pay datasets on file. No model,
// no network, $0.
//
// Per figure (a case passes when all five hold):
//   label     the hand label agrees with the recorded posting (Greenhouse min_cents/max_cents/currency, Lever salaryRange, Ashby's
//             compensation summary, Workday's own sentence); a label that does not stops the run (it is the set that is wrong)
//   read      the figure the product stores for that posting and place is the posting's figure, as stated (career_ingest.ts
//             boardPay; workday_posting.ts payFrom / paysByPlace)
//   yearly    career_offer_chat.ts yearlyRange gives the yearly US-dollar range for a yearly USD figure and nothing for an hourly,
//             unit-less or non-USD one (never converted)
//   compare   the comparison rows are exact: each base (an hourly figure x 2,080, labelled so), the signing bonus, guaranteed
//             first-year cash = base + signing (worked out), each figure's source labelled, and an amount said in AUD or PLN is
//             never shown as US dollars
//   sourced   every dollar figure in the compare reply is one the asker gave, one worked out from those, or one the cited pay
//             data publishes (career_offer.ts benchmarks for that offer)
// Reported, not a case: the posted-pay benchmark (postedPay) over these real postings where a role and metro has 5 or more.
//
//   deno run -A --no-check evals/real-sets/offers/run.ts
// deno-lint-ignore-file no-explicit-any require-await
import { offerChatTurn, postedPay, yearlyRange } from "../../../supabase/functions/_shared/career_offer_chat.ts";
import { benchmarks, parseOfferWords, payData } from "../../../supabase/functions/_shared/career_offer.ts";
import { loadPostings } from "../postings/postings.ts";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 12, 15);
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
interface Fig { id: string; job_id: string; employer: string; place: string; lo: number; hi: number; currency: string; unit: string; from: string; stated: string; role: string; city: string; asker_unit?: string }
const figs: Fig[] = JSON.parse(await Deno.readTextFile(`${HERE}figures.json`)).figures;
const rows = new Map((await loadPostings()).map((r) => [r.job_id, r]));
const raw = async (file: string) => JSON.parse(await Deno.readTextFile(`${HERE}../postings/recorded/${file}`));
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#xa;/g, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function labelOk(f: Fig): Promise<string | null> {
  const row = rows.get(f.job_id);
  if (!row) return `no recorded posting ${f.job_id}`;
  const j = await raw(row.file);
  if (row.provider === "greenhouse") return (j.pay_input_ranges ?? []).some((r: any) => r.min_cents === f.lo * 100 && r.max_cents === f.hi * 100 && r.currency_type === f.currency) ? null : "no Greenhouse range with these cents";
  if (row.provider === "lever") { const r = j.salaryRange; return r && r.min === f.lo && r.max === f.hi && r.currency === f.currency ? null : "Lever salaryRange differs"; }
  if (row.provider === "ashby") return j.compensation?.compensationTierSummary === f.stated ? null : "Ashby summary differs";
  const t = decode(String(j.jobPostingInfo?.jobDescription ?? ""));
  return t.includes(f.place) && t.includes(f.stated.replace(/ Hourly$| Annually$/, "")) ? null : "the Workday text does not state this place and range";
}
function readOk(f: Fig): boolean {
  const row = rows.get(f.job_id)!;
  // boardPay joins a board's ranges with "; " (and a zone's own label may hold "; "): the figure is one whole part of it.
  if (row.provider !== "workday") { const p = row.pay ?? "", at = p.indexOf(f.stated); return at >= 0 && (at === 0 || p.slice(at - 2, at) === "; ") && (at + f.stated.length === p.length || p.slice(at + f.stated.length, at + f.stated.length + 2) === "; "); }
  if (row.pays.length) return row.pays.some((p) => p.place === f.place && p.pay === f.stated);
  return row.pay === f.stated && row.location.startsWith(f.place); // one range read: it is the primary place's
}
function yearlyOk(f: Fig): boolean {
  const y = yearlyRange(f.stated);
  return f.currency === "USD" && f.unit === "year" ? !!y && y.lo === f.lo && y.hi === f.hi : y === null;
}
const hourly = (f: Fig) => f.unit === "hour" || f.asker_unit === "hour";
const said = (f: Fig, n: number) => f.currency !== "USD" ? `${f.currency} ${n.toLocaleString("en-US")}` : hourly(f) ? `$${n} an hour` : usd(n);
const baseOf = (f: Fig, n: number) => hourly(f) ? n * 2080 : n;

interface Case { id: string; a: string; b: string; checks: Record<string, boolean>; notes: string[]; pass: boolean; reply?: string }
const cases: Case[] = [];
for (let i = 0; i < figs.length; i++) {
  const A = figs[i];
  let k = (i + 1) % figs.length;
  while (figs[k].employer === A.employer) k = (k + 1) % figs.length;
  const B = figs[k];
  const bad = await labelOk(A);
  if (bad) throw new Error(`${A.id}: the label does not match the recording (${bad}); fix figures.json`);
  const an = (w: string) => /^[aeiou]/i.test(w) || /^AI\b/.test(w) ? "an" : "a";
  const ma = `${A.employer} offered me ${said(A, A.lo)} base as ${an(A.role)} ${A.role} in ${A.city}`;
  const mb = `${B.employer} offered me ${said(B, B.hi)} base and a $10,000 signing bonus as ${an(B.role)} ${B.role} in ${B.city}`;
  const notes: string[] = [];
  let state: any = null, last: any = null;
  // The asker answers one follow-up question the way a person would (the city, or the job title), then asks to compare.
  for (const [m, f] of [[ma, A], [mb, B], ["compare my offers", null]] as [string, Fig | null][]) {
    last = await offerChatTurn({ message: m, state, now: NOW, postings: null }); state = last.state;
    if (f && last.answer?.status === "ask") {
      const q = String(last.answer.reply);
      const ans = /job title/i.test(q) && /city/i.test(q) ? `${f.role} in ${f.city}` : /job title/i.test(q) ? `I'm ${an(f.role)} ${f.role}` : `It's in ${f.city}`;
      last = await offerChatTurn({ message: ans, state, now: NOW, postings: null }); state = last.state;
      if (!last.answer || last.answer.status === "ask") notes.push(`not kept: "${m}" was asked "${q.split("\n")[0].replace(/^.*?(To place it)/, "$1")}", and the answer "${ans}" ${last.answer ? "was asked again" : "was not taken"}`);
    }
  }
  const cmp = last?.answer?.comparison;
  const row = (o: any, k2: string) => o?.rows?.find((r: any) => r.k === k2);
  const ba = baseOf(A, A.lo), bb = baseOf(B, B.hi);
  const want = (f: Fig, n: number, base: number) => f.currency !== "USD" ? null : hourly(f) ? `$${n} an hour x 2,080 hours = ${usd(base)} a year` : usd(base);
  let compare = !!cmp && cmp.offers?.length === 2;
  if (compare) {
    const [oa, ob] = cmp.offers;
    const checks: [boolean, string][] = [
      [oa.company === A.employer && ob.company === B.employer, `companies ${oa.company}, ${ob.company}`],
      [A.currency === "USD" ? row(oa, "Base")?.v === want(A, A.lo, ba) : !String(row(oa, "Base")?.v ?? "").includes("$"), `A base "${row(oa, "Base")?.v}"`],
      [B.currency === "USD" ? row(ob, "Base")?.v === want(B, B.hi, bb) : !String(row(ob, "Base")?.v ?? "").includes("$"), `B base "${row(ob, "Base")?.v}"`],
      [row(oa, "Base")?.src?.label === "you told me" && row(ob, "Base")?.src?.label === "you told me", "base source"],
      [row(oa, "Signing bonus")?.v === null && row(ob, "Signing bonus")?.v === "$10,000" && row(ob, "Signing bonus")?.src?.label === "you told me", "signing rows"],
      [A.currency !== "USD" || String(row(oa, "Guaranteed first-year cash")?.v ?? "").startsWith(`${usd(ba)} (`), `A guaranteed "${row(oa, "Guaranteed first-year cash")?.v}"`],
      [B.currency !== "USD" || String(row(ob, "Guaranteed first-year cash")?.v ?? "").startsWith(`${usd(bb + 10000)} (`), `B guaranteed "${row(ob, "Guaranteed first-year cash")?.v}"`],
      [row(oa, "Guaranteed first-year cash")?.src?.label === "worked out" && row(ob, "Guaranteed first-year cash")?.src?.label === "worked out", "worked out label"],
    ];
    for (const [ok, what] of checks) if (!ok) { compare = false; notes.push(`compare: ${what}`); }
  } else notes.push(`no two-offer comparison (status ${last?.answer?.status})`);
  // Every dollar figure in the reply: given, worked out, or published by the cited data.
  const reply = String(last?.answer?.reply ?? "");
  const allowed = new Set<number>([10000, ba, bb, bb + 10000, A.lo, B.hi]);
  for (const m of [ma, mb]) for (const b of benchmarks(parseOfferWords(m), payData())) for (const v of [b.median, b.p25, b.p75]) if (v != null) allowed.add(Math.round(v));
  const dollars = [...reply.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, ""))));
  const stray = dollars.filter((d) => !allowed.has(d));
  const sourced = !!reply && stray.length === 0;
  if (!sourced) notes.push(`dollar figures with no source: ${stray.map(usd).join(", ") || "(no reply)"}`);
  const checks = { read: readOk(A), yearly: yearlyOk(A), compare, sourced };
  if (!checks.read) notes.push(`read: the product stores "${rows.get(A.job_id)!.pay}"${rows.get(A.job_id)!.pays.length ? ` and ${JSON.stringify(rows.get(A.job_id)!.pays)}` : ""}, not "${A.stated}" for ${A.place}`);
  if (!checks.yearly) notes.push(`yearly: yearlyRange("${A.stated}") = ${JSON.stringify(yearlyRange(A.stated))}`);
  cases.push({ id: `${A.id}+${B.id}`, a: ma, b: mb, checks: { label: true, ...checks }, notes, pass: Object.values(checks).every(Boolean), reply });
}

// Reported: the posted-pay benchmark over these real postings (yearly USD ranges), for each role and metro the product reads.
const reader = { search: async () => [...rows.values()].filter((r) => r.pay).map((r) => ({ company: r.company, title: r.title, location: r.location, pay: r.pay })) };
const bench: string[] = [];
for (const [role, city] of [["software engineer", "New York"], ["software engineer", "San Francisco"], ["data scientist", "New York"]]) {
  const o = parseOfferWords(`Acme Example offered me $150,000 base as a ${role} in ${city}`);
  const p = await postedPay(o, reader as any, payData(), NOW);
  bench.push(`${role}, ${city}: ${p ? (p.shown ? `median ${usd(p.median!)} p25 ${usd(p.p25!)} p75 ${usd(p.p75!)} from ${p.n}` : `not shown (${p.reason})`) : "not run"}`);
}

const n = cases.length, pass = cases.filter((c) => c.pass).length, bar = Math.ceil(n * 0.95);
const per = ["read", "yearly", "compare", "sourced"].map((k) => `${k} ${cases.filter((c) => c.checks[k]).length}/${n}`).join(", ");
const made = cases.filter((c) => !c.notes.some((x) => x.startsWith("no two-offer comparison")));
const line = `REAL-SET OFFERS: ${n} real posted pay figures (${new Set(figs.map((f) => f.job_id)).size} postings, ${new Set(figs.map((f) => f.employer)).size} employers) -> ${n} comparisons; ${per}; PASS ${pass}/${n} (bar ${bar}/${n}) ${pass >= bar ? "MEETS" : "BELOW"}; reported: comparisons the product made ${made.length}/${n}, exact when made ${made.filter((c) => c.checks.compare).length}/${made.length}`;
for (const c of cases) if (!c.pass) console.log(`FAIL ${c.id}: ${c.notes.join("; ")}`);
console.log(`posted-pay benchmark on these postings (reported): ${bench.join(" | ")}`);
await Deno.mkdir(`${HERE}results`, { recursive: true });
await Deno.writeTextFile(`${HERE}results/latest.json`, JSON.stringify({ at: new Date().toISOString(), line, bench, cases }, null, 1) + "\n");
console.log(line);
Deno.exit(pass >= bar ? 0 : 1);
