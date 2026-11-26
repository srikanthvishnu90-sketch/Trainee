// deno-lint-ignore-file no-explicit-any require-await
// Item 10 loop (k-research, 2026-11-10): 15 company and role research asks through the REAL handler (handleChat) on Postgres 16, with
// a scripted model on the Anthropic wire ($0) over a fixture web whose facts are known (tests/helpers/research_loop_web.ts). The
// scripted model drafts like a capable model that also makes the E.5 mistakes (items 42-49): volume called revenue, a forecast stated
// as a result, an undated or wrongly dated development, a competitor its quote never names, an invented initiative (in a line, a
// question, the reading and the reply), an unknown with an invented figure, and once a reply that is only a list of links.
// The scorer below does not trust the product's guards: it traces every line of the brief (the saved File, or the chat answer) and
// every figure in the reply to a sentence on a page the reader actually opened, and checks dates, metric meaning, the reading's
// label and role-grounded questions against the fixture's truth. Bar: 0 unsourced claims, 0 inventions, 15/15 briefs pass.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/loop-10-research.test.ts   (as a non-root user)
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { type Company, COMPANIES, companyOf, draftFor, INVENTED, loopWeb, pageAt } from "../helpers/research_loop_web.ts";
import { isSupportJudgeCall, supportJudgeAnswer } from "./support-test-judge.ts";

const CI = Deno.env.get("CI") === "true";
type Ask = { n: number; c: Company; text: string; role: string | null; format: "file" | "inline"; focus?: "questions"; audience?: string; badFrame: boolean; linksOnly?: boolean };
const [L, O, K, T, Q] = COMPANIES;
const ASKS: Ask[] = [];
const add = (a: Omit<Ask, "n">) => ASKS.push({ ...a, n: ASKS.length + 1 });
for (const c of COMPANIES) {
  add({ c, role: c.role, format: "file", badFrame: c === L || c === K || c === Q, text: `Research ${c.name} before my ${c.role.toLowerCase()} interview: the business, recent developments, competitors and what I should ask.` });
  add({ c, role: c.role, format: "inline", badFrame: c === O || c === T, text: `I have a ${c.name} ${c.role.toLowerCase()} interview. Answer here in chat with sources: what they do, what's new, and 5 good questions to ask.` });
}
add({ c: L, role: null, format: "file", badFrame: false, text: "Research Lumen Pay before my interview. I want the company, business model, recent developments and what I should ask." });
add({ c: T, role: null, format: "file", badFrame: true, text: "Can you dig into Tidewater Energy for me before my interview next week?" });
add({ c: O, role: O.role, format: "file", focus: "questions", audience: "hiring manager", badFrame: false, text: `Less generic: what should I ask the hiring manager at Orbit Freight for the ${O.role.toLowerCase()} role?` });
add({ c: Q, role: Q.role, format: "file", focus: "questions", audience: "recruiter", badFrame: false, text: `What should I ask the Quill Learning recruiter about the ${Q.role.toLowerCase()} job?` });
add({ c: K, role: K.role, format: "file", badFrame: false, linksOnly: true, text: `Research Kestrel Health for my ${K.role.toLowerCase()} interview and give me the sources.` });

// ---------------------------------------------------------------- the scripted model
const askOf = (msg: string) => ASKS.find((a) => msg.includes(a.text)) ?? null;
const results = new Map<number, any>();
const scripted = async (body: any): Promise<Response> => {
  const msgs: any[] = body.messages ?? [], tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  const sys = String(msgs.find((m) => m.role === "system")?.content ?? "");
  const lastUser = String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
  const last = msgs.at(-1);
  const reply = (message: any) => new Response(JSON.stringify({ id: "fake", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the handler's support judge calls the
  // model through this same wire; it is answered as the deterministic test judge would (a JSON array, support-test-judge.ts), and
  // it never advances the brain's script.
  if (isSupportJudgeCall(sys)) return reply({ role: "assistant", content: supportJudgeAnswer(lastUser) });
  if (/You prepare a company brief/.test(sys)) {
    const c = companyOf(/COMPANY: (.+)/.exec(lastUser)?.[1]?.trim() ?? "")!;
    const a = ASKS.find((x) => x.c === c && lastUser.includes(x.text.slice(0, 200).replace(/\s+/g, " ").slice(0, 60))) ?? ASKS.find((x) => x.c === c)!;
    return reply({ role: "assistant", content: JSON.stringify(draftFor(c, { questionsOnly: /Fill ONLY that key/.test(sys), badFrame: a.badFrame })) });
  }
  const a = askOf(msgs.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n"));
  if (tools.includes("plan_task") || !a) return reply({ role: "assistant", content: "I can't help with that here." });
  if (tools.includes("research_company") && last?.role !== "tool") {
    const input: any = { company: a.c.name, question: a.text, format: a.format, sites: [a.c.host] };
    if (a.role) input.role = a.role;
    if (a.focus) Object.assign(input, { focus: a.focus, audience: a.audience });
    return reply({ role: "assistant", content: null, tool_calls: [{ id: `r${a.n}`, type: "function", function: { name: "research_company", arguments: JSON.stringify(input) } }] });
  }
  let r: any = null;
  try { r = JSON.parse(String(last?.content ?? "")); } catch { /* not JSON */ }
  results.set(a.n, r);
  const c = a.c, src = (url: string) => (r?.sources ?? []).find((s: any) => s.url === url)?.n ?? 1;
  const news = src(c.pages[0].url), pa = src(c.pages[1].url);
  if (a.linksOnly) return reply({ role: "assistant", content: `Here are the sources:\n${c.pages.map((p) => `- ${p.url}`).join("\n")}` });
  const roleQ = a.role ? "" : " What role are you interviewing for? When is the interview?";
  const text = a.format === "inline"
    ? `${c.pages[1].sentences[0].text.replace(/\.$/, "")} [${pa}]. ${c.rev.text.replace(/\.$/, "")} [${news}]. ${c.name} made ${c.vol.fig} in revenue in 2025 [${news}]. ${c.fcDone.replace(/\.$/, "")} [${news}]. ${c.name} is also launching a crypto lending product [${pa}].`
    : `The brief covers how ${c.name} makes money through ${c.products[0]} and ${c.products[1]}, with dated recent developments and questions grounded in real tradeoffs. ${c.name} made ${c.vol.fig} in revenue in 2025. ${c.fcDone} ${c.name} is also launching a crypto lending product. The brief with its sources is in the file.${roleQ}`;
  return reply({ role: "assistant", content: text });
};

// ---------------------------------------------------------------- the scorer (the fixture's truth, not the product's guards)
const FIG = /\$\s?\d[\d,.]*(?:\s*(?:million|billion|trillion))?|\b\d+(?:\.\d+)?\s*%|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s+(?:million|billion|trillion)\b/gi;
const REVENUE_WORD = /\b(?:revenue|revenues|sales|income|earn(?:ed|s|ings)?|made|profit)\b/i;
const FORECAST_WORD = /\b(?:expects?|expected|on track|plans?|aims?|projects?|projected|forecasts?|targets?)\b/i;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shortDay = (d: string) => { const m = /^(\w+) (\d+), (\d{4})$/.exec(d)!; return `${MON[MONTHS.indexOf(m[1])]} ${m[2]}, ${m[3]}`; };
const sq = (s: string) => s.replace(/\s+/g, " ").trim();
const truthWith = (c: Company, fig: string) => c.pages.flatMap((p) => p.sentences).filter((s) => sq(s.text).toLowerCase().includes(sq(fig).toLowerCase()));
const inventedIn = (s: string) => INVENTED.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(s));
type Score = { reply?: string; n: number; company: string; shape: string; pass: boolean; unsourced: string[]; invented: string[]; other: string[]; lines: number };

function score(a: Ask, r: any, file: any, reply: string, read: Set<string>): Score {
  const unsourced: string[] = [], invented: string[] = [], other: string[] = [];
  const c = a.c, d = file ?? r;
  if (!r || r.status !== "ok" || !d) return { n: a.n, company: c.name, shape: shape(a), pass: false, unsourced, invented, other: [`no brief (status ${r?.status ?? "none"})`], lines: 0 };
  const sources: any[] = d.sources ?? [];
  const pagesFor = (cite: number[]) => (cite ?? []).map((n) => sources[n - 1]?.url).filter(Boolean).map((u: string) => { if (!read.has(u)) other.push(`cites a source never opened: ${u}`); return pageAt(u); }).filter(Boolean);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): a line that is its page's own sentence is
  // shown as that sentence in quotation marks (with "From <host>: " when the page lends the company's name); a page's heading read
  // with the sentence under it ("<page title> <sentence>") is the page's own words too. Inside the marks it must still be exactly a
  // sentence of a page it cites; nothing else traces.
  const QUOTED = /^(?:From [^:"]+: )?"(.*)"$/s;
  const inner = (text: string) => QUOTED.exec(sq(text))?.[1] ?? null;
  const traced = (text: string, cite: number[]) => { const q = inner(text); return pagesFor(cite).flatMap((p: any) => p.sentences.map((s: any) => ({ s, title: p.title }))).find(({ s, title }: any) => sq(s.text) === sq(text) || (q !== null && (sq(s.text) === sq(q) || sq(`${title} ${s.text}`) === sq(q))))?.s ?? null; };
  let lines = 0;
  for (const sec of ["business", "developments", "competitors", "role_asks"] as const) {
    for (const x of d[sec] ?? []) {
      lines++;
      const t = traced(x.text, x.cite);
      if (!t) { (inventedIn(x.text).length ? invented : unsourced).push(`${sec}: ${x.text}`); continue; }
      if (sec === "competitors" && !sq(t.text).includes(x.name)) unsourced.push(`competitor ${x.name} not named by its source`);
      if (sec === "developments") {
        const p = pagesFor(x.cite)[0] as any;
        if (!p?.date || x.date !== shortDay(p.date)) unsourced.push(`development dated "${x.date}" but its page says ${p?.date ?? "no date"}: ${x.text}`);
        if ((t.kind === "volume" || t.kind === "forecast") && x.measure !== t.kind) other.push(`development not labelled ${t.kind}: ${x.text}`);
      }
    }
  }
  if (d.frame) {
    if (inventedIn(d.frame.text).length) invented.push(`reading: ${d.frame.text}`);
    // Architect amendment (same): a reading the judge does not pass is shown as its page's own sentence, quoted, citing that page.
    else if (sq(d.frame.text) !== sq(c.frame) && !traced(d.frame.text, d.frame.cite)) unsourced.push(`reading not from the pages: ${d.frame.text}`);
  }
  for (const q of d.questions ?? []) {
    const ok = c.tensions.some((t) => sq(q.text) === `Your team is working on ${t.area.charAt(0).toLowerCase()}${t.area.slice(1)}. How do you decide between ${t.a} and ${t.b}?`);
    if (!ok) (inventedIn(q.text).length ? invented : unsourced).push(`question: ${q.text}`);
  }
  for (const u of d.unknowns ?? []) { if (inventedIn(u).length) invented.push(`unknown: ${u}`); else if ((u.match(FIG) ?? []).length) unsourced.push(`unknown with a figure: ${u}`); }
  // Role-specific: with a role, the full brief reads the role page and asks questions grounded in the pages.
  if (a.role && !a.focus && a.format === "file" && !(d.role_asks ?? []).length) other.push("no line from the role page");
  if (a.role && (d.questions ?? []).length === 0) other.push("no grounded question for the role");
  // Interpretation is labelled as such.
  if (d.frame) {
    if (file) { const rec: any = { id: "f", userId: "u", kind: "research_brief", data: file, state: {}, tag: null, created_at: Date.now(), expires_at: Date.now() + 3600_000, revoked_at: null };
      if (!/Trainee(?:&#39;|')s reading/.test(bodyHtml(rec, "fs1." + "a".repeat(64)))) other.push("the reading is not labelled in the File"); }
    else if (!reply.includes("My interpretation, not a sourced fact")) other.push("the reading is not labelled in chat");
  }
  if (a.focus === "questions") lines += (d.questions ?? []).length; // a questions-only brief is its grounded questions (spec WO-H/3)
  if (lines < 2) other.push(`only ${lines} sourced line(s): not a brief`);
  // The reply: every figure traces to a page sentence and keeps its meaning; nothing invented; not a plain list of links.
  const prose = reply.split("\n").filter((l) => !/^\[\d+\] .*https?:\/\//.test(l)).join("\n");
  for (const s of prose.split(/(?<=[.!?])\s+|\n+/).map(sq).filter(Boolean)) {
    if (inventedIn(s).length) { invented.push(`reply: ${s}`); continue; }
    for (const f of s.match(FIG) ?? []) {
      const t = truthWith(c, f);
      if (!t.length) unsourced.push(`reply figure ${f} on no page: ${s}`);
      else if (t.every((x) => x.kind === "volume") && REVENUE_WORD.test(s)) unsourced.push(`reply calls volume revenue: ${s}`);
      else if (t.every((x) => x.kind === "forecast") && !FORECAST_WORD.test(s)) unsourced.push(`reply states a forecast as a result: ${s}`);
    }
  }
  const words = prose.replace(/https?:\/\/\S+/g, " ").split(/(?<=[.!?])\s+|\n+/).filter((s) => sq(s).split(" ").length >= 6);
  if (!words.length) other.push("the reply is a plain list of links");
  if (file) { const rec: any = { id: "f", userId: "u", kind: "research_brief", data: file, state: {}, tag: null, created_at: Date.now(), expires_at: Date.now() + 3600_000, revoked_at: null };
    for (const w of inventedIn(textOf(rec, { now: Date.now() }))) if (!invented.some((x) => x.toLowerCase().includes(w.toLowerCase()))) invented.push(`File text: ${w}`); }
  return { reply, n: a.n, company: c.name, shape: shape(a), pass: !unsourced.length && !invented.length && !other.length, unsourced, invented, other, lines };
}
const shape = (a: Ask) => [a.format, a.role ? "role" : "no role", a.focus ? `focus ${a.focus}` : "", a.linksOnly ? "links reply" : ""].filter(Boolean).join(", ");

Deno.test({ name: "item 10 loop: 15 research asks at the real handler; every claim sourced, dated, meaning kept, nothing invented", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_PLANNER", "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "BRAVE_SEARCH_API_KEY", "RESEARCH_SEARCH_PROVIDER", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  const realResolve = Deno.resolveDns;
  const PEOPLE = Object.fromEntries(ASKS.map((a) => [`tok-r${a.n}`, `7b0f8f8e-6a43-4a49-9d2c-0000001000${String(a.n).padStart(2, "0")}`]));
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const scores: Score[] = [];
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "RESEARCH_SEARCH_PROVIDER", "CAREER_PLANNER"]) Deno.env.delete(k); // the release values (D-047)
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-loop10-not-a-key");
    Deno.env.set("BRAVE_SEARCH_API_KEY", "brave-fake-loop10-not-a-key"); // answered by the fixture web below
    Deno.env.set("TRAINEE_FILE_BASE_URL", "https://trainee.example/file"); // so a brief File can be made and its link signed
    Deno.env.set("TRAINEE_FILE_LINK_SECRET", "loop10-test-link-secret-not-real-000000000000");
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["203.0.113.30"] : []);
    const log: string[] = [];
    const web = loopWeb(log);
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).hostname === "api.anthropic.com") return anthropicWire(req, (b) => scripted(b));
      return web(req);
    }) as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const h = handler;
    for (const a of ASKS) {
      const id = PEOPLE[`tok-r${a.n}`];
      const t = await h.chat(`tok-r${a.n}`).say(a.text);
      assertNode.equal(t.status, 200, t.reply);
      const rows = JSON.parse((await pg.sql(`select coalesce(jsonb_agg(value order by updated_at), '[]') from public.career_watch_kv where user_id = '${id}' and key like 'tf:file:%'`)) || "[]");
      const file = rows.at(-1)?.data ?? null;
      if (file) { const v: any = validateKind("research_brief", file, { now: Date.now() }); if (!v.ok) throw new Error(`ask ${a.n}: the saved brief does not validate: ${v.errors}`); }
      scores.push(score(a, results.get(a.n), file, t.reply, new Set(log.map((u) => u.replace(/\/$/, "")))));
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    (Deno as any).resolveDns = realResolve;
    handler?.restore();
    await pg.stop();
  }
  const sum = (f: (s: Score) => number) => scores.reduce((n, s) => n + f(s), 0);
  for (const s of scores) {
    console.log(`${s.pass ? "PASS" : "FAIL"} ${String(s.n).padStart(2)} ${s.company} (${s.shape}): ${s.lines} lines`);
    if (Deno.env.get("LOOP10_SHOW")) console.log(`     reply: ${JSON.stringify(s.reply)}`);
    for (const x of [...s.unsourced.map((u) => `unsourced: ${u}`), ...s.invented.map((u) => `invented: ${u}`), ...s.other]) console.log(`     - ${x}`);
  }
  const line = `LOOP-10 research: ${sum((s) => +s.pass)}/${ASKS.length} briefs pass; unsourced claims ${sum((s) => s.unsourced.length)}; invented ${sum((s) => s.invented.length)}; other ${sum((s) => s.other.length)}`;
  console.log(line);
  assertNode.equal(ASKS.length, 15);
  assertNode.equal(sum((s) => s.unsourced.length), 0, line);
  assertNode.equal(sum((s) => s.invented.length), 0, line);
  assertNode.equal(sum((s) => +s.pass), 15, line);
} });
