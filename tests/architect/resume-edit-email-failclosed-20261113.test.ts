// Review of #776 and #785 (2026-11-13), three findings, each reproduced here before its fix. $0, no database, no model.
//   1 MAJOR    an edit to a resume version dropped an entry's own headline detail and the changelog said the opposite.
//   2 MINOR    an entry's text was split at "Dr." and other abbreviations.
//   3 BLOCKER  only the bracketed "[your email]" was refused: you@example.com / name@domain.com passed the ATS check, was
//              stored with a link, and could reach an application. Every entry point is held here: the render, the tailor,
//              the chat tool, the email card and its yes, the form card (prepare-ahead), the cloud card, the cloud submit
//              and the local submit.
//   deno test -A --no-check tests/architect/resume-edit-email-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender, CareerRouter, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import * as T from "../../supabase/functions/_shared/career_tailor.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { supabaseResumes } from "../../supabase/functions/_shared/career_apply_email.ts";
import { tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { runApproved } from "../../workers/career-browser/approve-first.ts";
import { runCloudJob } from "../../workers/career-cloud/worker.ts";
import { prepareCloudCard } from "../../workers/career-cloud/prepare.ts";
import { authorizer, cardBound } from "../helpers/cloud_card_auth.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const TT = T as any;
const pdfText = (pdf: Uint8Array) => (R.extractPdfLines(Buffer.from(pdf)) as string[]).join("\n");
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
const NOW = Date.UTC(2026, 10, 13, 12), USER = "00000000-0000-4000-8000-000000001113";
const POSTING = { text: "Software Engineer Intern at PayPal (TEST)\n\nSummer 2027 software engineering internship. Python, Java, SQL.", job_id: "greenhouse:paypalwa1:9101", company: "PayPal" };
const RESUME = (email: string, extra = "") => `Here's my resume:
Dana Okafor
${email}${extra}
Experience
Northwind Logistics, Operations Analyst (Jan 2022 - Mar 2024): cut freight cost 18% across 40 lanes.
- Built a Python forecasting model used by 12 planners
- Reduced late shipments from 9% to 4%
- Managed a $2.4M carrier budget
Acme Robotics, Software Engineer Intern (Jun 2021 - Aug 2021): shipped a SQL dashboard for 300 users; wrote 45 unit tests.
Blue Heron Cafe, Shift Lead (2019 - 2021): trained 6 new hires. Handled $3k in daily cash with Dr. Smith's audit.
Education
Lakeshore University, BS Computer Science, May 2022`;
function person(email = "dana.okafor@gmail.com", extra = "") {
  const ctx: any = { now: NOW, thread: {} };
  CareerRouter.handleChat(RESUME(email, extra), ctx); CareerRouter.handleChat("Yes, that's my resume", ctx);
  ok(ctx.profile.resume_header?.confirmed_at, "the resume and its header are confirmed");
  return ctx.profile;
}
const typed = (email: string) => { const p = person(); p.basics = { ...(p.basics || {}), name: "Dana Okafor", email }; return p; };
const tailor = (profile: any, o: any = {}, store = T.memoryResumeStore()) => T.tailorForPosting({ userId: USER, profile, posting: POSTING, deps: { render: T.edgeRenderer(), resumes: store }, now: NOW, ...o }) as Promise<any>;
// A file with a placeholder contact, made by the renderer alone (no gate): what a defect upstream could hand a submit gate.
async function files() {
  const good: any = await tailor(person());
  ok(good.ok, JSON.stringify(good).slice(0, 300));
  const doc = structuredClone(good.detail.doc); doc.header = { ...doc.header, email: "you@example.com", contactLine: null };
  const bad = new Uint8Array(R.renderPdf(doc).buffer);
  ok(pdfText(bad).includes("you@example.com"));
  return { good: good.detail.pdf as Uint8Array, bad, doc: good.detail.doc };
}

// ------------------------------------------------------------------------------------------------ 1 and 2: edits
// Each row: a confirmed entry, the word that names it, and the details its own words hold (finding 2's truth table).
const ENTRIES: { role: string; kind?: string; title: string; text?: string; bullets?: string[]; details: string[] }[] = [
  { role: "Northwind", title: "Northwind Logistics, Operations Analyst (Jan 2022 - Mar 2024): cut freight cost 18% across 40 lanes.", bullets: ["Built a Python forecasting model used by 12 planners", "Reduced late shipments from 9% to 4%", "Managed a $2.4M carrier budget"],
    details: ["cut freight cost 18% across 40 lanes", "Built a Python forecasting model used by 12 planners", "Reduced late shipments from 9% to 4%", "Managed a $2.4M carrier budget"] },
  { role: "Acme", title: "Acme Robotics, Software Engineer Intern (Jun 2021 - Aug 2021): shipped a SQL dashboard for 300 users; wrote 45 unit tests.", details: ["shipped a SQL dashboard for 300 users", "wrote 45 unit tests"] },
  { role: "Blue Heron", title: "Blue Heron Cafe, Shift Lead (2019 - 2021): trained 6 new hires. Handled $3k in daily cash with Dr. Smith's audit.", details: ["trained 6 new hires", "Handled $3k in daily cash with Dr. Smith's audit"] },
  { role: "Orbit", title: "Orbit Labs Inc., Analyst (2020 - 2021): reported to J. Rivera at Orbit Labs Inc. Grew revenue 2.5x to $1.2M in the U.S. market.", details: ["reported to J. Rivera at Orbit Labs Inc. Grew revenue 2.5x to $1.2M in the U.S. market"] },
  { role: "Mary", title: "St. Mary's Hospital, Volunteer (2018): logged 120.5 hours; trained with Mr. Lee, e.g. on intake. Covered No. 4 ward.", details: ["logged 120.5 hours", "trained with Mr. Lee, e.g. on intake", "Covered No. 4 ward"] },
  { role: "Delta", title: "Delta Co., Engineer (2019 - 2020): built parsers (JSON; XML; CSV) for 3 teams; cut p95 latency from 1.2s to 0.4s.", details: ["built parsers (JSON; XML; CSV) for 3 teams", "cut p95 latency from 1.2s to 0.4s"] },
  { role: "Kite", title: "Kite Ltd., Intern (Summer 2017)", text: "Wrote 30 tests for Dr. A. Gupta's lab. Shipped v2.0 to 5 schools.", details: ["Wrote 30 tests for Dr. A. Gupta's lab", "Shipped v2.0 to 5 schools"] },
  { role: "Pine", title: "Pine & Co, Buyer (2016): negotiated 12 vendor contracts.", text: "Saved $40k in 2016 with the U.S. team. Led 3 audits.", details: ["negotiated 12 vendor contracts", "Saved $40k in 2016 with the U.S. team", "Led 3 audits"] },
  { role: "Trailmap", kind: "project", title: "Trailmap, Creator (2023): 1,200 monthly users; 4.8 rating on 350 reviews; featured by Outdoor Weekly.", details: ["1,200 monthly users", "4.8 rating on 350 reviews", "featured by Outdoor Weekly"] },
  { role: "Lakeshore", kind: "education", title: "Lakeshore University, BS Computer Science, May 2022", details: [] },
];
const FACTS = ENTRIES.map((e, i) => ({ id: `F-${i + 1}`, kind: e.kind ?? "experience", status: "confirmed", title: e.title, text: e.text ?? e.title, bullets: e.bullets ?? [] }));
// This file's own reading of what an entry holds (not the code's): every number and every capitalised word.
const holds = (s: string) => [...new Set(s.match(/\d+(?:[.,]\d+)*|[A-Z][A-Za-z]+/g) ?? [])];
const sourceOf = (f: any) => [f.title, f.text !== f.title ? f.text : "", ...f.bullets].join(" ");
const blockOf = (resume: any, id: string) => resume.sections.flatMap((s: any) => s.lines).filter((l: any) => (l.factIds || []).includes(id)).map((l: any) => l.text as string);

Deno.test("finding 2: a confirmed line is cut at ';' and sentence ends only; never at Dr., Inc., U.S., e.g., an initial, a decimal or inside brackets", () => {
  for (const [i, e] of ENTRIES.entries()) eq(T.entryParts(FACTS[i]).details, e.details, e.role);
  const more: [string, string[]][] = [
    ["met Ms. Okoro weekly. Filed 3 reports", ["met Ms. Okoro weekly", "Filed 3 reports"]], ["worked vs. Team B on pricing", ["worked vs. Team B on pricing"]],
    ["ran the i.e. Friday close. Closed 14 books", ["ran the i.e. Friday close", "Closed 14 books"]], ["moved to St. Louis for Acme Corp. Opened 2 sites", ["moved to St. Louis for Acme Corp. Opened 2 sites"]],
    ["raised $1.5M. Hired 4", ["raised $1.5M. Hired 4"]], ["grew 3.5%. Then 7%", ["grew 3.5%", "Then 7%"]], ["used SQL. Then Python", ["used SQL. Then Python"]],
    ["shipped v1 (beta. Then GA); sold 9", ["shipped v1 (beta. Then GA)", "sold 9"]], ["QA; UX", ["QA", "UX"]], ["one thing", ["one thing"]],
  ];
  for (const [text, want] of more) eq(TT.splitDetails(text), want, text);
});

Deno.test("finding 1: 60 edits (10 entries x 1 to 6 lines): 48 that do not ask for fewer lines lose nothing; 12 asked-for shortenings keep the head and name what they left out", () => {
  const profile = { facts: FACTS }, base = T.keepEveryEntry({ sections: [] }, profile).resume;
  const count = { kept: 0, shortened: 0 };
  for (const [i, e] of ENTRIES.entries()) for (const lines of [1, 2, 3, 4, 5, 6]) {
    const f = FACTS[i], label = `${e.role} to ${lines}`, 
      // What the version being edited prints for it: every detail (Kite's are in its text, which that version does not print).
      shorten = lines < (e.text && !e.title.includes(": ") ? 0 : e.details.length);
    const r: any = T.applyEdits(base, profile, [{ role: e.role, lines }]);
    ok(r.ok, `${label}: ${r.reason}`);
    const printed = blockOf(r.resume, f.id), text = printed.join("\n"), d = r.done[0], said = T.editLine(r.done);
    const lost = holds(sourceOf(f)).filter((t) => !text.includes(t));
    eq(printed.length - 1, d.now, `${label}: the count said is the count printed`);
    eq([d.now, d.available, d.restored], [Math.min(lines, e.details.length), e.details.length, []], label);
    if (shorten) {
      count.shortened++;
      // Asked for fewer lines than print: the head stays whole, the first details stay, the rest is named word for word.
      eq([printed[0], printed.slice(1), d.left_out, d.complete, d.change], [T.entryParts(f).head, e.details.slice(0, lines), e.details.slice(lines), false, "condensed"], label);
      eq(lost.filter((t) => !d.left_out.join(" ").includes(t)), [], `${label}: everything not printed is in left_out`);
      ok(said.includes(`(left out of ${e.title.split(",")[0]}: `) && d.left_out.every((x: string) => said.includes(x)) && !/all the confirmed record holds|nothing confirmed was dropped/.test(said), `${label}: ${said}`);
    } else {
      count.kept++;
      eq([lost, d.left_out, d.complete], [[], [], true], `${label}: lost from the confirmed entry; printed ${JSON.stringify(printed)}`);
      eq(/all the confirmed record holds/.test(said), lines > e.details.length, `${label}: ${said}`);
      ok(!/left out/.test(said), said);
    }
    // Every other entry is untouched, word for word.
    for (const g of FACTS) if (g.id !== f.id) eq(blockOf(r.resume, g.id), blockOf(base, g.id), `${label}: ${g.id} unchanged`);
  }
  eq(count, { kept: 48, shortened: 12 });
  // Not asked for fewer than print (the delivered version printed the entry on one line, no bullets): the lines share the details.
  const one = T.keepEveryEntry({ sections: [] }, profile, { oneLine: true }).resume;
  const up: any = T.applyEdits(one, profile, [{ role: "Northwind", lines: 2 }]);
  eq([holds(sourceOf(FACTS[0])).filter((t) => !blockOf(up.resume, "F-1").join("\n").includes(t)), up.done[0].left_out, up.done[0].now], [[], [], 2]);
});

Deno.test("finding 1: the reviewer's cases through tailorForPosting: the headline detail prints, in the file itself; a shortening says what it left out", async () => {
  const p = person();
  const all = ["Northwind Logistics", "Jan 2022 - Mar 2024", "18%", "40 lanes", "12 planners", "9% to 4%", "$2.4M", "Acme Robotics", "Jun 2021 - Aug 2021", "300 users", "45 unit tests", "Blue Heron Cafe", "2019 - 2021", "6 new hires", "$3k", "Dr. Smith's audit", "May 2022"];
  const cases: [any[], string[]][] = [[[{ role: "Northwind", lines: 6 }], []], [[{ role: "Blue Heron", lines: 4 }], []], [[{ role: "Northwind", lines: 4 }, { role: "Acme", lines: 2 }], []],
    [[{ role: "Northwind", lines: 1 }], ["12 planners", "9% to 4%", "$2.4M"]], [[{ role: "Acme", lines: 1 }], ["45 unit tests"]], [[{ role: "Acme", lines: 1 }, { role: "Northwind", lines: 2 }], ["9% to 4%", "$2.4M", "45 unit tests"]]];
  for (const [edits, out] of cases) {
    const r = await tailor(p, { edits }), label = JSON.stringify(edits);
    ok(r.ok, `${label}: ${r.reason}`);
    const flat = pdfText(r.detail.pdf).replace(/\s+/g, " ");
    eq(all.filter((t) => !flat.includes(t)), out, `${label}: missing from the file`);
    const named = r.edits.flatMap((e: any) => e.left_out).join(" ");
    ok(out.every((t) => named.includes(t) && r.changelog.includes(t)) && /left out of/.test(r.changelog) === out.length > 0, `${label}: ${r.changelog}`);
    ok(out.length || r.edits.every((e: any) => e.complete === true), label);
    ok(!out.length || !/all the confirmed record holds|nothing confirmed was dropped/.test(r.changelog), r.changelog);
  }
  const six = await tailor(p, { edits: [{ role: "Northwind", lines: 6 }] });
  eq([six.edits[0].now, six.edits[0].available, six.edits[0].expand_short], [4, 4, true]);
  ok(/all the confirmed record holds for it/.test(six.changelog), six.changelog);
});

Deno.test("finding 1: an edit that would still lose something is printed whole or refused with what it would drop; the claim is never asserted", () => {
  const f = { id: "F-1", kind: "experience", status: "confirmed", title: "Acme Robotics, Engineer: shipped 3 services; wrote 45 tests.", text: "Acme Robotics, Engineer: shipped 3 services; wrote 45 tests.", bullets: [] };
  const version = (line: string) => ({ sections: [{ heading: "Experience", lines: [{ text: line, factIds: ["F-1"], type: "entry" }] }] });
  // The delivered version printed the entry's dates after its line: shortening it keeps them by printing the entry whole.
  const whole: any = T.applyEdits(version(`${f.title} (2020 - 2022)`), { facts: [f] }, [{ role: "Acme", lines: 1 }]);
  ok(whole.ok, whole.reason);
  eq(holds(`${f.title} 2020 2022`).filter((t) => !blockOf(whole.resume, "F-1").join(" ").includes(t)), []);
  eq([whole.done[0].restored, whole.done[0].change], [["2020", "2022"], "unchanged"]);
  ok(/printed whole.*2020, 2022/.test(T.editLine(whole.done)) && !/condensed/.test(T.editLine(whole.done)), T.editLine(whole.done));
  // The delivered line holds what the record's own line cannot carry: refused, saying what, nothing made up.
  const no: any = T.applyEdits(version("Engineer at Acme Robotics, Berlin, 2020"), { facts: [f] }, [{ role: "Acme", lines: 1 }]);
  ok(!no.ok && /would drop/.test(no.reason) && /Berlin/.test(no.reason) && /2020/.test(no.reason), JSON.stringify(no));
  // The sentence about the whole record is said only when the comparison found it so.
  const done = { role: "x", entry: "Acme Robotics, Engineer", asked: 6, before: 2, now: 2, available: 2, change: "unchanged", added_back: false, led: true, expand_short: true, complete: false, restored: [], left_out: [] };
  ok(!/all the confirmed record holds/.test(T.editLine([done as any])), T.editLine([done as any]));
});

Deno.test("round 2 D/E: what is said about an entry is its final state; a shared employer is named with title and dates; colons, accents, kana and quotes", () => {
  const five = { id: "F-1", kind: "experience", status: "confirmed", title: "Northwind Logistics, Operations Analyst (Jan 2022 - Mar 2024): cut freight cost 18%.", text: "", bullets: ["Built 2 models", "Cut late shipments to 4%", "Ran a $2.4M budget", "Hired 6 planners"] };
  const more = [{ id: "F-2", kind: "experience", status: "confirmed", title: "Northwind Logistics, Intern (Jun 2021 - Aug 2021): shipped a dashboard; wrote 45 tests.", text: "", bullets: [] },
    { id: "F-3", kind: "project", status: "confirmed", title: "Capstone: Route Planner, Team Lead (2023): led 4 students; won 1st of 30 teams.", text: "", bullets: [] },
    { id: "F-4", kind: "experience", status: "confirmed", title: "ETH Zürich, Research Assistant (2020): ran 12 experiments; wrote 2 papers.", text: "", bullets: [] },
    { id: "F-5", kind: "experience", status: "confirmed", title: "メルカリ, Engineer (2019): built search; cut latency 30%.", text: "", bullets: [] }];
  for (const f of [five, ...more]) f.text = f.title;
  const profile = { facts: [five, ...more] }, base = T.keepEveryEntry({ sections: [] }, profile).resume;
  const run = (edits: any[]) => { const r: any = T.applyEdits(base, profile, edits); ok(r.ok, r.reason); return { r, said: T.editLine(r.done) as string, block: (id: string) => blockOf(r.resume, id) }; };
  // 5 -> 1 -> 5 in one call: all five print, so nothing is said to be left out.
  const back = run([{ role: "Operations Analyst", lines: 1 }, { role: "Operations Analyst", lines: 5 }]);
  eq([back.block("F-1").length - 1, back.r.done.length, back.r.done[0].left_out], [5, 1, []]);
  ok(!/left out|condensed/.test(back.said), back.said);
  // 6 -> 2 in one call: it stays where it was, and is not said to be first unless it is.
  const down = run([{ role: "Intern", lines: 6 }, { role: "Intern", lines: 1 }]);
  const first = down.r.resume.sections.find((x: any) => x.heading === "Experience").lines[0].factIds[0];
  eq([first, /now first in its section/.test(down.said)], ["F-1", false], down.said);
  // Two entries at one employer: what was left out names the entry by its title and dates.
  ok(down.said.includes("(left out of Northwind Logistics, Intern (Jun 2021 - Aug 2021): wrote 45 tests)"), down.said);
  ok(run([{ role: "Zurich", lines: 1 }]).said.includes("(left out of ETH Zürich: wrote 2 papers)"));
  // Two entries grown in one section: only the one that ends first is said to be.
  const two = run([{ role: "Zürich", lines: 3 }, { role: "メルカリ", lines: 3 }]);
  eq([two.r.done.map((d: any) => d.led), (two.said.match(/now first in its section/g) || []).length], [[false, true], 1], two.said);
  // A title with its own colon keeps its line whole.
  eq(T.entryParts(more[1]), { head: "Capstone: Route Planner, Team Lead (2023)", details: ["led 4 students", "won 1st of 30 teams"] });
  eq(run([{ role: "Capstone", lines: 1 }]).block("F-3"), ["Capstone: Route Planner, Team Lead (2023)", "led 4 students"]);
  // E: no cut inside quotation marks.
  eq(TT.splitDetails('won "Best Demo. Runner Up; 2022" award; hired 3'), ['won "Best Demo. Runner Up; 2022" award', "hired 3"]);
  eq(TT.splitDetails("said “ship it. Now; today” twice. Shipped 2"), ["said “ship it. Now; today” twice", "Shipped 2"]);
});

// ------------------------------------------------------------------------------------------------ 3: the contact
// Round 2: the rule is syntax, then reserved domains, then equality with a confirmed email; a template's stand-in name on a real
// domain is asked about, never refused. No real person's address is refused by a guess.
const REFUSED_EMAILS = ["", " ", "[your email]", "<email>", "{{email}}", "%EMAIL%", "your email", "[email protected]", "you@example.com", "name@example.org", "dana@example.net", "dana@example.edu", "dana@sub.example.com", "dana@example.co.uk",
  "dana@host.invalid", "dana@localhost", "dana@box.local", "dana@foo.example", "YOU@EXAMPLE.COM", "mailto:dana.okafor@gmail.com", "dana okafor@gmail.com", "dana..okafor@gmail.com", "dana@gmail..com", "dana@gmail.com.", ".dana@gmail.com",
  "dana.@gmail.com", "dana@-gmail.com", "dana@gmail-.com", "dana@@gmail.com", "dana@gmail.c", "dana@", "@gmail.com", "dana.gmail.com", "dana@gmail.com, dana2@gmail.com", "dаna@gmail.com", "dana＠gmail.com", "dana@127.0.0.1", "user@domain.tld"];
const REAL_EMAILS = ["a.khan@gmail.com", "dana.okafor@gmail.com", "d.okafor+jobs@outlook.com", "priya_s@cs.stanford.edu", "mei-lin.chen@alumni.berkeley.edu", "tom@smith.dev", "me@danaokafor.com", "josé.garcía@gmail.com", "dana@müller.de", "o'brien@tcd.ie",
  "dana@company.technology", "dana@email.com", "dana@domain.com", "me@me.com", "dana@例え.jp", "k.nakamura@g.ecc.u-tokyo.ac.jp", "dana@example-labs.com", "user1@gmail.com", "null.pointer@gmail.com", "DANA.OKAFOR@GMAIL.COM", "johndoe123@gmail.com", "1234567@qq.com"];
const DOUBTFUL_EMAILS = ["you@gmail.com", "name@domain.com", "yourname@gmail.com", "your.name@gmail.com", "first.last@university.edu", "firstname.lastname@outlook.com", "first_last@yahoo.com", "email@gmail.com", "user@company.org", "test@gmail.com", "john.doe@gmail.com", "jane.doe@outlook.com"];
const BAD_PHONES = ["555-0100", "555-0199", "(212) 555-0142", "+1 212 555 0142", "123-456-7890", "(123) 456-7890", "+1 123 456 7890", "1234567890", "(xxx) xxx-xxxx", "XXX-XXX-XXXX", "(NNN) NNN-NNNN", "(###) ###-####", "(555) 555-5555", "000-000-0000", "555-123-4567",
  "111-111-1111", "(999) 999-9999", "987-654-3210", "(415) 000-0000", "415-123-4567", "+44 7700 900123", "07700 900000", "+61 491 570 156", "41586753091234567", "+00 000 000 0000", "[phone]", "{{phone}}"];
const GOOD_PHONES = ["(415) 867-5309", "+1 212-736-5000", "646.555.0234", "312-555-1212", "+44 20 7183 8750", "+44 7911 123456", "+91 98765 43210", "+49 30 901820", "+33 1 42 68 53 00", "+81 3-1234-5678", "4158675309", "(415) 867-5309 ext. 12", "020 7183 8750", "+86 138 0013 8000", "Chicago, IL 60614", "2019 - 2021"];

Deno.test("finding 3: 115 emails and phones: malformed, reserved and template ones are refused; no real address is; a template's stand-in name is asked about", () => {
  eq(REFUSED_EMAILS.length + REAL_EMAILS.length + DOUBTFUL_EMAILS.length + BAD_PHONES.length + GOOD_PHONES.length, 115);
  for (const e of REFUSED_EMAILS) ok(typeof R.placeholderEmail(e) === "string" && R.placeholderEmail(e), `refused: ${JSON.stringify(e)}`);
  for (const e of REAL_EMAILS) eq([R.placeholderEmail(e), R.doubtfulEmail(e), R.contactProblems({ email: e })], [null, null, []], e);
  for (const e of DOUBTFUL_EMAILS) {
    eq(R.placeholderEmail(e), null, `${e}: possible, so never refused outright`);
    eq(R.contactProblems({ email: e }).map((c: any) => c.level), ["confirm"], e);
    eq(R.contactProblems({ email: e }, { checked: [e] }), [], `${e}: theirs once they typed it for the resume`);
  }
  for (const p of BAD_PHONES) ok(R.placeholderPhones(`Chicago, IL | ${p} | linkedin.com/in/dana`).length === 1, `refused: ${p}`);
  for (const p of GOOD_PHONES) eq(R.placeholderPhones(`Chicago, IL | ${p} | dana.okafor@gmail.com`), [], p);
  for (const line of ["linkedin.com/in/yourname | github.com/dana", "Your City, ST | Phone", "City, State", "Chicago | [phone]"]) ok(R.contactProblems({ email: "dana.okafor@gmail.com", contactLine: line }).some((c: any) => c.level === "refuse"), line);
});

Deno.test("finding 3, the render: a placeholder email or phone at the top is not a pass and cannot be marked ready, on the plain and the designed layouts", async () => {
  const { doc } = await files(), render = T.edgeRenderer();
  const withHeader = (h: any) => ({ ...structuredClone(doc), header: { ...doc.header, ...h } });
  for (const [h, field] of [[{ email: "you@example.com" }, "email"], [{ email: "name@example.org" }, "email"], [{ email: "" }, "email"], [{ contactLine: "dana.okafor@gmail.com | (555) 555-5555" }, "phone"], [{ contactLine: "you@example.com | 312-867-5309" }, "email"]] as const) {
    for (const opts of [undefined, { layout: "trainee" }] as any[]) {
      const r: any = await render(withHeader(h), opts);
      ok(r.ok && r.ats.pass === false && r.ats.status === "FAIL" && r.ats.reasons.some((x: string) => x.startsWith("contact_unconfirmed:") && x.includes(`the ${field} is not confirmed`)), `${JSON.stringify(h)} ${JSON.stringify(opts)}: ${JSON.stringify(r.ats ?? r)}`);
    }
  }
  const fine: any = await render(withHeader({ contactLine: "dana.okafor@gmail.com | (312) 867-5309" }));
  ok(fine.ats.pass, JSON.stringify(fine.ats));
});

Deno.test("finding 3, the tailor (the call the apply paths make): typed or on the resume header, a placeholder email or phone is refused and nothing is stored", async () => {
  for (const email of ["you@example.com", "name@example.org", "dana@sub.example.com", "mailto:dana.okafor@gmail.com", "[your email]"]) {
    for (const o of [{}, { reviewDraft: true }, { contact: "typed" }]) {
      const store = T.memoryResumeStore(), r = await tailor(typed(email), o, store);
      ok(!r.ok && r.refused === "no_contact" && /cannot go on a resume/.test(r.reason) && !/not an email they confirmed/.test(r.reason) && r.reason.includes(T.EMAIL_QUESTION), `${email} ${JSON.stringify(o)}: ${JSON.stringify(r).slice(0, 300)}`);
      eq([store.files.size, store.signed.length], [0, 0], `${email}: nothing stored, no link`);
    }
  }
  for (const [email, extra] of [["you@example.com", ""], ["you@example.com", " | (555) 555-5555"], ["dana.okafor@gmail.com", " | (555) 555-0123"], ["dana.okafor@gmail.com", " | 123-456-7890"]]) {
    for (const o of [{}, { reviewDraft: true }]) {
      const store = T.memoryResumeStore(), r = await tailor(person(email, extra), o, store);
      ok(!r.ok && r.refused === "no_contact" && /No resume was made or stored/.test(r.reason), `${email}${extra}: ${JSON.stringify(r).slice(0, 300)}`);
      eq(store.files.size, 0);
    }
  }
  // The email that prints is the one they confirmed: an assembler that prints another is refused.
  const other = (p: any, jd: any, o: any) => { const t = (CareerTailor as any).tailorResume(p, jd, o); t.resume.header = { ...t.resume.header, email: "someone.else@gmail.com" }; return t; };
  const store = T.memoryResumeStore();
  const r: any = await T.tailorForPosting({ userId: USER, profile: person(), posting: POSTING, deps: { render: T.edgeRenderer(), resumes: store, tailor: other }, now: NOW });
  ok(!r.ok && /is not the email they confirmed/.test(r.reason) && store.files.size === 0, JSON.stringify(r).slice(0, 300));
  // A template's stand-in name on a real domain is asked about, truthfully, and is theirs once they type it for the resume.
  for (const email of ["john.doe@gmail.com", "first.last@university.edu", "name@domain.com"]) {
    const profile = typed(email), kept = T.memoryResumeStore(), ask = await tailor(profile, {}, kept);
    ok(!ask.ok && ask.refused === "contact_needs_confirmation" && ask.reason.includes(`Is ${email} your own email address?`) && !/not an email they confirmed|placeholder/.test(ask.reason) && kept.files.size === 0, JSON.stringify(ask).slice(0, 300));
    const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((x: any) => [x.name, x]));
    const c: any = { userId: USER, threadId: "t1", now: NOW, state: { profile }, turn: { message: `yes that is mine, use Dana Okafor and ${email}`, added: [] } };
    await tools.set_resume_contact.run({ name: "Dana Okafor", email }, c);
    const made = await tailor(c.state.profile, {}, kept);
    ok(made.ok && kept.files.size === 1 && pdfText(made.detail.pdf).includes(email), JSON.stringify(made).slice(0, 300));
  }
  for (const email of ["me@danaokafor.com", "josé.garcía@gmail.com", "dana@email.com"]) ok((await tailor(typed(email))).ok, `${email}: a real address is never refused`);
  // A real one, with a real phone, is made and stored as before.
  const real = T.memoryResumeStore(), fine = await tailor(person("a.khan@gmail.com", " | (312) 867-5309"), {}, real);
  ok(fine.ok && fine.link && real.files.size === 1 && fine.ats.status !== "FAIL", JSON.stringify(fine).slice(0, 300));
});

Deno.test("finding 3, the chat tool: tailor_resume refuses a placeholder email with or without a deliverer; nothing is sent or stored", async () => {
  for (const deliver of [true, false]) {
    const sent: any[] = [], store = T.memoryResumeStore();
    const tools = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async (id: string) => ({ job_id: id, title: "Software Engineer Intern", company: "PayPal", description: POSTING.text }), personas: T.memoryPersonaStore(), resumes: store, render: T.edgeRenderer(), versions: null, ...(deliver ? { deliver: (d: any) => sent.push(d) } : {}) } } as any).map((x: any) => [x.name, x]));
    let out: any;
    try { out = await tools.tailor_resume.run({ job_id: POSTING.job_id }, { userId: USER, threadId: "t1", now: NOW, state: { profile: typed("you@example.com") }, turn: { message: "make my resume for paypal", added: [] } }); } catch (e) { out = { threw: String((e as Error).message) }; }
    ok(out.threw ? /cannot go on a resume/.test(out.threw) : out.ok === false, JSON.stringify(out).slice(0, 300));
    eq([sent.length, store.files.size], [0, 0]);
  }
});

Deno.test("finding 3, the email card and its yes: no resume for a card from a placeholder email; a stored file with one is not attached at the yes", async () => {
  const { good, bad } = await files(), objects = new Map<string, Uint8Array>();
  const admin = { storage: { from: () => ({ download: async (path: string) => objects.has(path) ? { data: new Blob([objects.get(path)! as BlobPart]) } : { error: { message: "not found" } } }) } };
  const store: any = { ...T.memoryResumeStore(), put: async (path: string, pdf: Uint8Array) => { objects.set(path, pdf); }, signedUrl: async (path: string) => `https://project.supabase.test/storage/v1/object/sign/career-resumes/${path}?token=t` };
  const post: any = { job_id: POSTING.job_id, title: "Software Engineer Intern", company: "PayPal", description: POSTING.text };
  for (const profile of [typed("you@example.com"), typed("name@domain.com"), person("you@example.com")]) {
    eq(await supabaseResumes(admin, { profile: () => profile, tailor: { render: T.edgeRenderer(), resumes: store } }).resume(USER, post), null);
    eq(objects.size, 0);
  }
  const r = supabaseResumes(admin, { profile: () => person(), tailor: { render: T.edgeRenderer(), resumes: store } });
  const card = await r.resume(USER, post);
  ok(card && card.tailored && (await r.attachment(USER, card.sha256))?.sha256 === card.sha256, "a real contact still reaches the card and the yes");
  // At the yes: the stored bytes are read again. A file with a placeholder (however it got there) is not attached.
  const badSha = await hex(bad); objects.set(T.resumePath(USER, badSha), bad);
  eq(await r.attachment(USER, badSha), null);
  ok(good.length > 0);
  // A renderer that wrongly passes a placeholder file: still no resume for the card (the bytes are read).
  const lying: any = async () => ({ ok: true, pdf: bad, sha256: badSha, filename: "resume.pdf", where: "test", ats: { pass: true, status: "PASS", reasons: [], warnings: [] } });
  eq(await supabaseResumes(admin, { profile: () => person(), tailor: { render: lying, resumes: store } }).resume(USER, post), null);
});

Deno.test("finding 3, the form card (prepare-ahead): no resume is prepared from a placeholder email, or from a file that carries one", async () => {
  const { bad } = await files(), dir = await Deno.makeTempDir();
  const c: any = { user_id: USER, job_id: POSTING.job_id, title: "Software Engineer Intern", company: "PayPal", description: POSTING.text };
  try {
    for (const email of ["you@example.com", "name@domain.com", "jane.doe@gmail.com"]) eq(await tailoredResume({ render: T.edgeRenderer(), resumes: T.memoryResumeStore(), now: () => NOW })(c, dir, typed(email)), null, email);
    const lying: any = async () => ({ ok: true, pdf: bad, sha256: await hex(bad), filename: "resume.pdf", where: "test", ats: { pass: true, status: "PASS", reasons: [], warnings: [] } });
    eq(await tailoredResume({ render: lying, resumes: T.memoryResumeStore(), now: () => NOW })(c, dir, typed("dana.okafor@gmail.com")), null);
    eq([...Deno.readDirSync(dir)].length, 0, "no file was written for a card");
    const fine = await tailoredResume({ render: T.edgeRenderer(), resumes: T.memoryResumeStore(), now: () => NOW })(c, dir, typed("dana.okafor@gmail.com"));
    ok(fine && /^[a-f0-9]{64}$/.test(fine.sha256), "a real typed email is prepared as before");
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("finding 3, the submit gates: the cloud card, the cloud submit and the local submit never start the engine with a placeholder-contact resume", async () => {
  const { good, bad } = await files();
  for (const [bytes, sends] of [[bad, false], [good, true]] as const) {
    const sha = await hex(bytes), b64 = Buffer.from(bytes).toString("base64");
    // Cloud submit (workers/career-cloud/worker.ts).
    const job = await cardBound({ id: "job-1", lease_token: "lease-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1",
      payload: { posting: "lever:test-co:de-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1", engine_approval: "c".repeat(64), resume_sha256: sha, fields: [] } });
    const finished: any[] = []; let runs = 0;
    const engine: any = async (_a: string[], _e: unknown, controls?: any) => { runs++; await controls?.beforeEffect?.(); return { result: { state: "submitted_unconfirmed", reason: "employer confirmation on the page" }, evidence: null }; };
    await runCloudJob(job as any, { queue: { claim: async () => [], gatePresent: async () => true, authorize: authorizer().authorize, resume: async () => ({ filename: "resume.pdf", sha256: sha, b64 }), finish: async (_j: unknown, state: string, ev: any) => { finished.push([state, ev?.reason ?? null]); } } as any, runEngine: engine, log: () => {} });
    eq([runs, finished], sends ? [1, [["submitted_unconfirmed", "employer confirmation on the page"]]] : [0, [["not_submitted", "RESUME_CONTACT_UNCONFIRMED"]]], "cloud submit");
    // Local submit (workers/career-browser/approve-first.ts runApproved).
    const path = await Deno.makeTempFile({ suffix: ".pdf" }); await Deno.writeFile(path, bytes);
    const local: any[] = []; runs = 0;
    try {
      await runApproved({ claim: async () => [{ id: "00000000-0000-4000-8000-000000000011", lease_token: "lease", url: "https://jobs.lever.co/test-co/de-1", payload: job.payload } as any], finish: async (_i, _l, state, ev) => { local.push([state, (ev as any)?.reason ?? null]); },
        resumeFor: async () => ({ path, sha256: sha }), writeFacts: async () => path, runEngine: engine });
    } finally { await Deno.remove(path); }
    eq([runs, local], sends ? [1, [["submitted_unconfirmed", "employer confirmation on the page"]]] : [0, [["not_submitted", "RESUME_CONTACT_UNCONFIRMED"]]], "local submit");
    // Cloud card (workers/career-cloud/prepare.ts): refused before any source is read or any dry run starts.
    const calls: string[] = [];
    const rpc: any = async (name: string) => { calls.push(name); if (name === "career_apply_message_cloud_prepare_context") return { resume: { sha256: sha, b64, filename: "resume.pdf" }, account: { epoch: 1, version: 1 } }; throw Error("STOP_AFTER_RESUME_GATE"); };
    const err = await prepareCloudCard({ owner: USER, thread: "00000000-0000-4000-8000-0000000000aa", urls: ["https://jobs.lever.co/test-co/de-1"], resumeSha256: sha }, { rpc, runEngine: engine }).then(() => "prepared", (e) => String(e?.message ?? e));
    ok(sends ? /STOP_AFTER_RESUME_GATE/.test(err) : /RESUME_CONTACT_UNCONFIRMED/.test(err) && calls.length === 1, `cloud card: ${err} after ${calls}`);
  }
});

// ------------------------------------------------------------------------------------------------ round 2 B/C: the recorded verdict
import { keptResume } from "../../workers/career-cloud/prepare-runner.ts";
import { prepare } from "../../workers/career-browser/approve-first.ts";
import { memoryVersionLog, recordVersion } from "../../supabase/functions/_shared/career_resume_outcomes.ts";
// A text PDF as another writer saves it: its content stream stored as it is, or ASCII85 over flate (ReportLab's default).
function foreignPdf(top: string, armour: boolean): Uint8Array {
  const content = `BT /F1 12 Tf 14.4 TL ET\nBT 1 0 0 1 72 740 Tm (Dana Okafor) Tj T* (${top.replace(/[()]/g, "\\$&")}) Tj T* (EXPERIENCE) Tj T* (Northwind Logistics, Analyst) Tj ET\n`;
  let body = content, filter = "";
  if (armour) {
    const z = zlib.deflateSync(Buffer.from(content, "latin1")); let a = "";
    for (let i = 0; i < z.length; i += 4) { const c = z.subarray(i, i + 4); let v = 0; for (let k = 0; k < 4; k++) v = v * 256 + (c[k] ?? 0); let s = ""; for (let k = 0; k < 5; k++) { s = String.fromCharCode(33 + (v % 85)) + s; v = Math.floor(v / 85); } a += s.slice(0, c.length + 1); }
    body = `${a}~>`; filter = "/Filter [ /ASCII85Decode /FlateDecode ] ";
  }
  return new TextEncoder().encode(`%PDF-1.3\n1 0 obj\n<< ${filter}/Length ${body.length} >>\nstream\n${body}endstream\nendobj\ntrailer\n<< >>\n%%EOF\n`);
}
const IMAGE_ONLY = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Length 3 >>\nstream\n\u0001\u0002\u0003\nendstream\nendobj\n%%EOF\n");

Deno.test("round 2 B: a stored resume carries its contact verdict; the gates read it, and a file no one could read is not ready", async () => {
  const p = person(), log = memoryVersionLog(), out = await tailor(p);
  eq(out.contact, { status: "ok", email_hash: crypto.createHash("sha256").update("dana.okafor@gmail.com").digest("hex") });
  await recordVersion(log, { userId: USER, out, now: NOW });
  eq((await log.get(USER)).files[out.sha256].contact, out.contact, "the verdict is on the version record");
  eq((await tailor(p, { reviewDraft: true })).contact?.status, "ok");
  // Other writers' text PDFs are read (they read as 0 lines before): a placeholder in one is seen.
  for (const armour of [false, true]) {
    const bad = foreignPdf("you@example.com | (555) 555-5555", armour), fine = foreignPdf("dana.okafor@gmail.com | (312) 867-5309", armour);
    ok(pdfText(bad).includes("you@example.com"), `armour ${armour}: the text is read`);
    eq([(await T.contactVerdict(bad)).status, (await T.contactVerdict(fine)).status], ["unconfirmed", "ok"]);
  }
  eq((await T.contactVerdict(IMAGE_ONLY)).status, "unread");
  eq((await T.contactVerdict(new TextEncoder().encode("%PDF-1.4\nnot a pdf you@example.com"))).status, "unread", "bytes that do not parse are not read (round 3: as trunk)");
  // The gate. A recorded verdict is read only when a row hands one; null or absent is "not recorded": the bytes alone decide.
  const good = out.detail.pdf as Uint8Array, gate = T.resumeFileContactProblems;
  eq(await gate(good, { record: out.contact }), []);
  eq(await gate(good, { record: out.contact, confirmed: [MINE] }), []);
  eq(await gate(good, { record: null }), [], "a row stored before the column (contact: null) is not blocked");
  eq(await gate(IMAGE_ONLY, { record: null }), [], "not recorded and not readable: passes, as on trunk");
  eq(await gate(IMAGE_ONLY, { record: { status: "unread", email_hash: null } }), []);
  ok((await gate(IMAGE_ONLY, { record: { status: "unconfirmed", email_hash: null, reasons: ["the email at the top (you@example.com) is on a reserved domain"] } }))[0].includes("you@example.com"), "a recorded refusal stands");
  ok((await gate(good, { record: out.contact, confirmed: ["someone.else@gmail.com"] }))[0].includes("is not the email they confirmed"), "the bytes read it first");
  ok((await gate(IMAGE_ONLY, { record: out.contact, confirmed: ["someone.else@gmail.com"] }))[0].includes("not the email they have confirmed now"), "the record, where the bytes cannot be read");
  eq(await gate(IMAGE_ONLY), []);
  eq(T.recordOf({ sha256: "x", contact: null }), { record: null });
  eq(T.recordOf({ sha256: "x" }), {});
});

Deno.test("round 2 B/C: every card and submit path: an unreadable or placeholder file with a storage record never gets a card or an engine run", async () => {
  const { good, bad } = await files(), okRec = await T.contactVerdict(good);
  const engineOf = (n: { runs: number }): any => async (_a: string[], _e: unknown, controls?: any) => { n.runs++; await controls?.beforeEffect?.(); return { result: { state: "submitted_unconfirmed", reason: "employer confirmation on the page" }, evidence: null }; };
  // Round 3 (item 4): a row with no record (contact: null, or no key as every production row today) is judged by its bytes alone.
  const cases: [string, Uint8Array, any, boolean][] = [["good, recorded ok", good, { contact: okRec }, true], ["good, row without a record", good, { contact: null }, true], ["image only, row without a record", IMAGE_ONLY, { contact: null }, true],
    ["image only, recorded unread", IMAGE_ONLY, { contact: { status: "unread", email_hash: null } }, true], ["placeholder, wrongly recorded ok", bad, { contact: okRec }, false],
    ["ReportLab placeholder, no record", foreignPdf("you@example.com", true), {}, false], ["recorded for another email", good, { contact: { status: "ok", email_hash: "0".repeat(64) } }, false]];
  for (const [label, bytes, row, ready] of cases) {
    const sha = await hex(bytes), b64 = Buffer.from(bytes).toString("base64"), n = { runs: 0 };
    const job = await cardBound({ id: "job-1", lease_token: "lease-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1",
      payload: { posting: "lever:test-co:de-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1", engine_approval: "c".repeat(64), resume_sha256: sha, fields: [{ label: "Email", value: MINE }] } });
    const fin: string[] = [];
    await runCloudJob(job as any, { queue: { claim: async () => [], gatePresent: async () => true, authorize: authorizer().authorize, resume: async () => ({ filename: "resume.pdf", sha256: sha, b64, ...row }), finish: async (_j: unknown, state: string, ev: any) => { fin.push(ev?.reason ?? state); } } as any, runEngine: engineOf(n), log: () => {} });
    eq([n.runs, fin[0] === "RESUME_CONTACT_UNCONFIRMED"], [ready ? 1 : 0, !ready], `cloud submit: ${label}`);
    const path = await Deno.makeTempFile({ suffix: ".pdf" }), dir = await Deno.makeTempDir(); await Deno.writeFile(path, bytes);
    try {
      const m = { runs: 0 }, loc: string[] = [];
      await runApproved({ claim: async () => [{ id: "00000000-0000-4000-8000-000000000011", lease_token: "lease", url: job.url, payload: job.payload } as any], finish: async (_i, _l, state, ev) => { loc.push((ev as any)?.reason ?? state); }, resumeFor: async () => ({ path, sha256: sha, ...row }), writeFacts: async () => path, runEngine: engineOf(m) });
      eq([m.runs, loc[0] === "RESUME_CONTACT_UNCONFIRMED"], [ready ? 1 : 0, !ready], `local submit: ${label}`);
      eq(!!(await keptResume(async () => ({ b64, sha256: sha, filename: "resume.pdf", ...row }))({ job_id: "x" }, dir, person())), ready, `the kept resume for a prepared card: ${label}`);
      const rpc: any = async (name: string) => { if (name === "career_apply_message_cloud_prepare_context") return { resume: { sha256: sha, b64, filename: "resume.pdf", ...row }, account: { epoch: 1, version: 1 } }; throw Error("PAST_THE_RESUME_GATE"); };
      const card = await prepareCloudCard({ owner: USER, thread: "00000000-0000-4000-8000-0000000000aa", urls: [job.url], resumeSha256: sha }, { rpc, runEngine: engineOf({ runs: 0 }) }).then(() => "prepared", (e) => String(e?.message ?? e));
      // The cloud card compares a record with the confirmed email only after it reads the profile (this rpc stops before).
      if (label !== "recorded for another email") eq(card.includes("PAST_THE_RESUME_GATE"), ready, `cloud card: ${label}: ${card}`);
    } finally { await Deno.remove(path); await Deno.remove(dir, { recursive: true }); }
  }
  // approve-first prepare() (the CLI's card and the batch): no dry run starts for a file whose contact is a placeholder.
  const path = await Deno.makeTempFile({ suffix: ".pdf" }); let runs = 0;
  try {
    await Deno.writeFile(path, bad);
    const r: any = await prepare({ url: "https://jobs.lever.co/test-co/de-1", factsPath: path, resumePath: path, account: { epoch: 1, version: 1 }, now: NOW, runEngine: (async () => { runs++; return null; }) as any });
    eq([r.ready, r.result.reason, runs], [false, "RESUME_CONTACT_UNCONFIRMED", 0]);
  } finally { await Deno.remove(path); }
  // Item 2 on this branch: the kept card compares with the profile prepareAhead hands it.
  const dir = await Deno.makeTempDir();
  try {
    for (const [bytes, ok2] of [[CHROME.differ, false], [CHROME.real, true]] as const) {
      const row = { b64: Buffer.from(bytes).toString("base64"), sha256: await hex(bytes), filename: "resume.pdf" };
      eq(!!(await keptResume(async () => row)({ job_id: "x" }, dir, person())), ok2, `kept card ${ok2}`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});

// ------------------------------------------------------------------------------------------------ round 3 (2026-11-13)
// Never worse than trunk: a file gate refuses only what it read with confidence (a well-formed address on a reserved domain,
// template text, a fiction-range phone, or a well-formed address that is not the one the person confirmed). A file whose
// contact it cannot read with confidence passes, as on trunk, and is said to be unread.
const FIX = (n: string) => Deno.readFileSync(new URL(`fixtures/resume-contact/${n}`, import.meta.url));
// Chrome's "Save as PDF" (Skia): text in reverse order, lines broken mid-address, and font programs that read as text.
const CHROME = { real: FIX("chrome-real.pdf"), priya: FIX("chrome-priya.pdf"), differ: FIX("chrome-differ.pdf"), example: FIX("chrome-example.pdf") };
const MINE = "dana.okafor@gmail.com";
async function rendered(email: string, line = `${email} | (312) 874-2291`, layout?: any) {
  const { doc } = await files(), d = { ...structuredClone(doc), header: { ...doc.header, email, contactLine: line } };
  if (!layout) return new Uint8Array(R.renderPdf(d).buffer);
  const r: any = await T.edgeRenderer()(d, layout);
  return r.pdf as Uint8Array;
}

Deno.test("round 3/1: real Chrome PDFs pass every file gate; font bytes read as text are never taken for an email", async () => {
  for (const [name, bytes] of Object.entries({ "chrome-real": CHROME.real, "chrome-priya": CHROME.priya })) {
    eq(await T.resumeFileContactProblems(bytes), [], name);
    eq(await T.resumeFileContactProblems(bytes, { confirmed: [name === "chrome-real" ? MINE : "priya.raman@outlook.com"] }), [], `${name}, with the confirmed email`);
    eq((await TT.resumeFileContact(bytes)).status, "ok", name);
  }
  const why = await T.resumeFileContactProblems(CHROME.example);
  ok(why.length === 1 && why[0].includes("dana@example.com") && !/[\u0000-\u001f]/.test(why.join("")), JSON.stringify(why));
  // Lines that are not printable text are not read as a contact.
  eq(R.fileContactProblems(["Dana Okafor", "MKHG\u0000\u0000\u0001\u0000#\u0000@$", "EXPERIENCE", "x"]), []);
  eq(R.fileContactProblems(["Dana Okafor", "dana.okafor@gmail.com", "«¨°þ@åÕ.co\u0006", "EXPERIENCE"]), []);
  // Not read with confidence: passes (as trunk), said to be unread.
  eq(await TT.resumeFileContact(new TextEncoder().encode("%PDF-1.4\nnot a pdf")), { status: "unread", reasons: [] });
  eq(R.fileContactProblems(["Casey Rivers", "Chicago, IL", "EXPERIENCE", "Support lead: answered help@example.com tickets"]), [], "an address in a sentence is not the contact");
});

Deno.test("round 3/2: a file email that is not the confirmed one is refused, truthfully, at every entry point", async () => {
  const theirs = await rendered("other.person@gmail.com"), mine = await rendered(MINE);
  for (const [name, bytes] of [["rendered", theirs], ["chrome", CHROME.differ]] as const) {
    const why = await T.resumeFileContactProblems(bytes, { confirmed: [MINE] });
    ok(why.length === 1 && why[0].includes("other.person@gmail.com") && why[0].includes("is not the email they confirmed"), `${name}: ${JSON.stringify(why)}`);
    eq(await T.resumeFileContactProblems(bytes), [], `${name}: with no confirmed email known, nothing is compared`);
  }
  eq(T.confirmedEmails(person()), [MINE]);
  // The email yes reads the person's confirmed email from their profile.
  const objects = new Map<string, Uint8Array>(), admin = { storage: { from: () => ({ download: async (path: string) => objects.has(path) ? { data: new Blob([objects.get(path)! as BlobPart]) } : { error: { message: "nf" } } }) } };
  const yes = supabaseResumes(admin, { profile: () => person(), tailor: null });
  for (const [bytes, sends] of [[theirs, false], [CHROME.differ, false], [mine, true], [CHROME.real, true]] as const) {
    const sha = await hex(bytes); objects.set(T.resumePath(USER, sha), bytes);
    eq(!!(await yes.attachment(USER, sha)), sends, `email yes ${sends}`);
  }
  // The submit workers read the email the person approved on the application itself (the payload's answers).
  const engineOf = (n: { runs: number }): any => async (_a: string[], _e: unknown, controls?: any) => { n.runs++; await controls?.beforeEffect?.(); return { result: { state: "submitted_unconfirmed", reason: "employer confirmation on the page" }, evidence: null }; };
  for (const [bytes, sends] of [[theirs, false], [CHROME.differ, false], [mine, true], [CHROME.real, true]] as const) {
    const sha = await hex(bytes), b64 = Buffer.from(bytes).toString("base64");
    const payload = { posting: "lever:test-co:de-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1", engine_approval: "c".repeat(64), resume_sha256: sha, fields: [{ label: "Email", value: MINE }] };
    const job = await cardBound({ id: "job-1", lease_token: "lease-1", user_id: "TEST-owner", company: "Test Co", url: payload.url, payload });
    const n = { runs: 0 }, fin: string[] = [];
    await runCloudJob(job as any, { queue: { claim: async () => [], gatePresent: async () => true, authorize: authorizer().authorize, resume: async () => ({ filename: "resume.pdf", sha256: sha, b64 }), finish: async (_j: unknown, _s: string, ev: any) => { fin.push(ev?.reason ?? ""); } } as any, runEngine: engineOf(n), log: () => {} });
    eq([n.runs > 0, fin[0] === "RESUME_CONTACT_UNCONFIRMED"], [sends, !sends], `cloud submit ${sends}`);
    const path = await Deno.makeTempFile({ suffix: ".pdf" }); await Deno.writeFile(path, bytes);
    const m = { runs: 0 }, loc: string[] = [];
    try {
      await runApproved({ claim: async () => [{ id: "00000000-0000-4000-8000-000000000011", lease_token: "lease", url: payload.url, payload } as any], finish: async (_i, _l, _s, ev) => { loc.push((ev as any)?.reason ?? ""); }, resumeFor: async () => ({ path, sha256: sha }), writeFacts: async () => path, runEngine: engineOf(m) });
    } finally { await Deno.remove(path); }
    eq([m.runs > 0, loc[0] === "RESUME_CONTACT_UNCONFIRMED"], [sends, !sends], `local submit ${sends}`);
    // The cloud card reads the person's profile from its sources snapshot, then compares.
    const { hashApplyPayload } = await import("../../supabase/functions/_shared/career_apply_store.ts");
    const profile = person(), owner = USER, rows: unknown[] = [];
    const rpc: any = async (name: string) => {
      if (name === "career_apply_message_cloud_prepare_context") return { resume: { sha256: sha, b64, filename: "resume.pdf" }, account: { epoch: 1, version: 1 } };
      if (name === "career_apply_message_cloud_sources") return { user_id: owner, profile, rows, digest: await hashApplyPayload({ user_id: owner, profile, rows }) };
      throw Error("PAST_THE_RESUME_GATE");
    };
    const card = await prepareCloudCard({ owner, thread: "00000000-0000-4000-8000-0000000000aa", urls: [payload.url], resumeSha256: sha }, { rpc, runEngine: (async () => null) as any }).then(() => "prepared", (e) => String(e?.message ?? e));
    eq(card.includes("RESUME_CONTACT_UNCONFIRMED"), !sends, `cloud card: ${card.slice(0, 120)}`);
  }
});

Deno.test("round 3/3: set_resume_contact confirms an address only when the person says it is theirs; internationalised addresses are not called invalid", async () => {
  const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((x: any) => [x.name, x]));
  const run = async (message: string, input: any, header = "first.last@gmail.com") => {
    const c: any = { userId: USER, threadId: "t1", now: NOW, state: { profile: header ? person(header) : person("Chicago, IL") }, turn: { message, added: [] } };
    let err = ""; try { await tools.set_resume_contact.run(input, c); } catch (e) { err = String((e as Error).message); }
    return { err, checked: c.state.profile.basics?.contact_checked ?? [], email: c.state.profile.basics?.email ?? null, after: await tailor(c.state.profile) };
  };
  for (const msg of ["first.last@gmail.com is NOT my email, my template had it. I'm Dana Okafor", "Dana Okafor here - should I use first.last@gmail.com or something else?", "the template says 'first.last@gmail.com' - Dana Okafor", "my old resume had first.last@gmail.com on it, weird right", "Dana Okafor, first.last@gmail.com isn't mine"]) {
    const r = await run(msg, { name: "Dana Okafor", email: "first.last@gmail.com" });
    ok(r.checked.length === 0 && !r.after.ok && r.after.refused === "contact_needs_confirmation", `${msg}: ${JSON.stringify(r).slice(0, 240)}`);
  }
  for (const msg of ["first.last@gmail.com is my email", "yes, first.last@gmail.com is mine", "use first.last@gmail.com", "my email is first.last@gmail.com"]) {
    const r = await run(msg, { email: "first.last@gmail.com" });
    ok(!r.err && r.checked.includes("first.last@gmail.com") && r.after.ok, `${msg}: ${JSON.stringify(r).slice(0, 240)}`);
  }
  for (const e of ["josé.garcía@gmail.com", "müller@gmx.de", "o'brien@gmail.com", "d'angelo.r@yahoo.com", "王伟@qq.com", "dana@münchen.de", "олег@почта.рф"]) {
    const r = await run(`my email is ${e}`, { email: e }, "");
    ok(!/not a valid email/.test(r.err) && r.email === e, `${e}: saved: ${JSON.stringify(r).slice(0, 200)}`);
    ok(r.after.ok || (r.after.refused === "no_contact" && /cannot print|can print only/.test(r.after.reason) && !/not a valid/.test(r.after.reason)), `${e}: ${JSON.stringify(r.after).slice(0, 260)}`);
  }
});

Deno.test("round 3/5-6: cut-short and counting phones are refused; '+1 555-01xx' passes only as a '(TEST)' fixture; a title's colon and a text that repeats its title", () => {
  for (const p of ["+1 (212) 5", "+1 (987) 654-3210", "+1 555-0100", "+1 555 0150", "+15550100"]) ok(R.placeholderPhones(`dana.okafor@gmail.com | ${p} | Chicago, IL`).length === 1, p);
  eq(R.placeholderPhones("Chicago, IL (TEST) | alex.testcase@example.test | +1 555-0100 (TEST)"), []);
  const pp = { id: "B5", kind: "experience", status: "confirmed", title: "Pied Piper, CTO: Compression (2017 - 2019)", text: "Pied Piper, CTO: Compression (2017 - 2019)", bullets: ["designed middle-out compression", "raised $5M seed"] };
  eq(T.entryParts(pp), { head: "Pied Piper, CTO: Compression (2017 - 2019)", details: ["designed middle-out compression", "raised $5M seed"] });
  const hooli = { id: "B2", kind: "experience", status: "confirmed", title: "Hooli, SRE (2021 - 2024)", text: "Hooli, SRE (2021 - 2024)\nmigrated to kubernetes\non-call lead", bullets: [] };
  eq(T.entryParts(hooli), { head: "Hooli, SRE (2021 - 2024)", details: ["migrated to kubernetes", "on-call lead"] });
  const base = T.keepEveryEntry({ sections: [] }, { facts: [pp, hooli] }).resume;
  const r: any = T.applyEdits(base, { facts: [pp, hooli] }, [{ role: "Hooli", lines: 2 }]);
  eq(blockOf(r.resume, "B2"), ["Hooli, SRE (2021 - 2024)", "migrated to kubernetes", "on-call lead"]);
});

// ------------------------------------------------------------------------------------------------ round 4 (2026-11-13)
Deno.test("round 4: a number is a placeholder only when it matches a known fiction or template pattern; Irish, South African and Ghanaian mobiles and a 7-digit local number are real", async () => {
  for (const p of ["087 412 9906", "082 456 7781", "024 412 9906", "555-2368", "(415) 867-530", "867-5309", "+353 87 412 9906", "+27 82 456 7781", "+233 24 412 9906"]) {
    eq(R.placeholderPhones(`dana.okafor@gmail.com | ${p} | Dublin`), [], `header: ${p}`);
    eq(R.placeholderPhones(`dana.okafor@gmail.com | ${p}`, { file: true }), [], `file: ${p}`);
  }
  // Trainee's own renderer prints them.
  for (const p of ["087 412 9906", "555-2368"]) {
    const out: any = await tailor(person("dana.okafor@gmail.com", ` | ${p}`));
    ok(out.ok, `${p}: ${JSON.stringify(out).slice(0, 200)}`);
  }
  for (const p of ["555-0123", "(212) 555-0142", "123-456-7890", "000-000-0000", "(xxx) xxx-xxxx", "+1 (987) 654-3210", "(555) 555-5555"]) ok(R.placeholderPhones(`dana.okafor@gmail.com | ${p}`).length === 1, p);
});

Deno.test("round 4: set_resume_contact never confirms an address the person gives as someone else's; an address followed by a full stop is read", async () => {
  const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((x: any) => [x.name, x]));
  const run = async (message: string, email: string) => {
    const c: any = { userId: USER, threadId: "t1", now: NOW, state: { profile: person("Chicago, IL") }, turn: { message, added: [] } };
    let err = ""; try { await tools.set_resume_contact.run({ email }, c); } catch (e) { err = String((e as Error).message); }
    return { err, email: c.state.profile.basics?.email ?? null, checked: c.state.profile.basics?.contact_checked ?? [] };
  };
  for (const [msg, e] of [["My friend's email is first.last@gmail.com", "first.last@gmail.com"], ["My manager uses john.doe@gmail.com for this", "john.doe@gmail.com"],
    ["use jane.doe@gmail.com, it is my husband's", "jane.doe@gmail.com"], ["My sister's address is dana.o@gmail.com", "dana.o@gmail.com"]]) {
    const r = await run(msg, e);
    ok(/someone else/.test(r.err) && r.email === null && !r.checked.length, `${msg}: ${JSON.stringify(r)}`);
  }
  const r = await run("my email is dana.okafor@gmail.com.", "dana.okafor@gmail.com");
  ok(!r.err && r.email === "dana.okafor@gmail.com" && r.checked.includes("dana.okafor@gmail.com"), JSON.stringify(r));
});

Deno.test("round 4 (c): the local preparation compares the file's email with the addresses in the facts it fills from", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const facts = `${dir}/facts.json`;
    await Deno.writeTextFile(facts, JSON.stringify({ user_id: USER, answers: { email: { value: MINE, confirmed: true } }, saved: {} }));
    for (const [bytes, ready] of [[CHROME.differ, false], [CHROME.real, true]] as const) {
      const path = `${dir}/resume.pdf`; await Deno.writeFile(path, bytes); let runs = 0;
      const r: any = await prepare({ url: "https://jobs.lever.co/test-co/de-1", factsPath: facts, resumePath: path, account: { epoch: 1, version: 1 }, now: NOW, runEngine: (async () => { runs++; return null; }) as any });
      eq([runs > 0, r.result?.reason === "RESUME_CONTACT_UNCONFIRMED"], [ready, !ready], `prepare ${ready}`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});
