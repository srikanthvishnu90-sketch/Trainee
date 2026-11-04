// The research invariants, shared by the pure battery (tests/architect/scenarios-billing-research.test.ts) and the
// Postgres run (tests/architect/flow-scenarios-billing-research.test.ts): one scenario through researchTurn over a fake
// web and a scripted model, then every part (answer, file, link message, stored report, model payload) checked. Returns
// the failures (each naming its scenario) and the reply. No network, no model.
import { INJECTION, pageHtml, REPORT_BASE, REPORT_SECRET, type ResearchScenario } from "./billing-research-generator.ts";
import { NO_SOURCES, ONE_SOURCE, researchParts, researchTurn, UNSUPPORTED } from "../../../supabase/functions/_shared/research_reply.ts";
import { fetchSources, isBlockedHost, normalizeUrl } from "../../../supabase/functions/_shared/research_sources.ts";
import { type ReportStore, verifyReportLink } from "../../../supabase/functions/_shared/research_report_store.ts";

export const FIXED = Date.UTC(2026, 9, 29, 12);
// Anything a phone or browser shows as a link: a scheme URL, a javascript:/data:/vbscript:/mailto: URI, a www. host, a
// host with a path. (A bare host name is a name.)
export const LINK = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|\b(?:javascript|data|vbscript|mailto|file):[^\s<>"']+|\bwww\.[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']*/gi;
export const linksIn = (s: string) => (String(s).match(LINK) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));

export function fakeWeb(pages: { url: string; status: number; type?: string; location?: string }[], html: (i: number) => string) {
  const byUrl = new Map(pages.map((p, i) => [normalizeUrl(p.url), i]));
  const calls: string[] = [];
  const f = (async (input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const i = byUrl.get(normalizeUrl(url));
    if (i === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const p = pages[i];
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html; charset=utf-8" };
    if (p.location) headers.location = p.location;
    return new Response(p.status >= 300 && p.status < 400 ? null : html(i), { status: p.status, headers });
  }) as typeof fetch;
  return { f, calls };
}
// The links a reply may carry: each candidate followed through the fake web to a 200 HTML page served over https,
// never a blocked site.
export function verifiedHttps(sc: ResearchScenario): Set<string> {
  const out = new Set<string>();
  const by = new Map(sc.pages.map((p) => [normalizeUrl(p.url), p]));
  for (const c of sc.candidates) {
    let u = normalizeUrl(c);
    for (let hop = 0; hop < 4; hop++) {
      const p = by.get(u);
      if (!p) break;
      if (p.status === 301 && p.location) { u = normalizeUrl(p.location); continue; }
      if (p.status === 200 && !p.type && u.startsWith("https://") && !isBlockedHost(u)) out.add(u);
      break;
    }
  }
  return out;
}
export const scriptedModel = (draft: unknown) => {
  const seen: any[] = [];
  return { seen, m: async (p: unknown) => {
    seen.push(p);
    if (draft instanceof Error) throw draft;
    return { content: [{ type: "text", text: typeof draft === "string" ? draft : JSON.stringify(draft) }] };
  } };
};
const pageTextOf = (sc: ResearchScenario) => new Map(sc.pages.map((p) => [normalizeUrl(p.url), [...p.sentences, ...(p.injectionInBody ? [INJECTION] : [])].join(" ")]));
const nrm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

export async function checkResearch(sc: ResearchScenario, o: { store: ReportStore; readReport: (id: string, url: string) => Promise<string | null>; userId: string; threadId?: string | null }) {
  const fails: string[] = [];
  const fail = (m: string) => fails.push(`#${sc.id} [${sc.draftKind}/${sc.store}/${sc.pages.length} pages] ${m}`);
  const web = fakeWeb(sc.pages, (i) => pageHtml(sc.pages[i]));
  const model = scriptedModel(sc.draft);
  const base = sc.store === "unconfigured" ? null : sc.store === "http_base" ? REPORT_BASE.replace("https:", "http:") : REPORT_BASE;
  const reply = await researchTurn({
    env: { get: (k) => k === "CAREER_RESEARCH_REPLY" ? "on" : undefined }, question: sc.question, candidates: sc.candidates,
    fetchSources: (u) => fetchSources(u, { fetch: web.f, now: () => FIXED }), model: model.m,
    report: { store: o.store, userId: o.userId, threadId: o.threadId === undefined ? `t-${sc.id}` : o.threadId, base, secret: REPORT_SECRET }, now: FIXED,
  });
  if (!reply) { fail("no reply"); return { fails, reply: null }; }
  const allowed = verifiedHttps(sc);
  const isAllowed = (u: string) => allowed.has(normalizeUrl(u)) || (!!reply.report && u === reply.report.url);
  // Never fetched: LinkedIn, Indeed, Handshake, javascript:, data:.
  for (const c of web.calls) if (isBlockedHost(c) || !/^https?:/.test(c)) fail(`fetched ${c}`);
  const parts = researchParts(reply);
  if (parts[0]?.kind !== "text") fail("the answer is not first");
  // The bubble: no link at all, no delivery claim, the injection never.
  if (linksIn(reply.answer).length) fail(`a link in the answer: ${linksIn(reply.answer).join(", ")}: ${reply.answer}`);
  if (/\bI(?:'ve| have)? attached|here(?:'s| is) the (?:full )?report|see the attached/i.test(reply.answer)) fail(`a delivery claim: ${reply.answer}`);
  if (/evil\.example|ignore previous instructions/i.test(reply.answer)) fail(`injection in the answer: ${reply.answer}`);
  if (!allowed.size) {
    if (!reply.answer.startsWith(NO_SOURCES)) fail(`no verified source, but: ${reply.answer}`);
  }
  const answered = !reply.answer.startsWith(NO_SOURCES) && !reply.answer.startsWith(UNSUPPORTED);
  if (!answered && parts.length !== 1) fail(`no answer, yet ${parts.map((p) => p.kind).join(",")} sent`);
  if (answered) {
    if (!reply.sources.length) fail("an answer with no source");
    const d = sc.draft as any;
    if (!d || typeof d !== "object" || typeof d.limits !== "string" || !d.limits.trim()) fail(`answered without evidence limits: ${reply.answer}`);
    if (reply.sources.length === 1 && !reply.answer.includes(ONE_SOURCE)) fail(`one source not said: ${reply.answer}`);
    if (reply.sources.length > 1 && reply.answer.includes(ONE_SOURCE)) fail(`"single source" with ${reply.sources.length}`);
    const notes = (reply.dropped.links.length ? 1 : 0) + (reply.dropped.report ? 1 : 0);
    if (!notes && reply.answer.length > 900) fail(`answer ${reply.answer.length} chars`);
    if (reply.answer.length > 1600) fail(`answer ${reply.answer.length} chars with notes`);
  }
  if (sc.store !== "ok" && reply.report) fail(`a report link with the store ${sc.store}`);
  if (reply.report && !(reply.report.url.startsWith(`${REPORT_BASE}/`) && await verifyReportLink(REPORT_SECRET, reply.report.url))) fail(`report link not signed: ${reply.report.url}`);
  // The link message: present exactly when a verified report or source exists, the URL alone, allowed.
  const linkParts = parts.filter((p) => p.kind === "link") as { kind: "link"; url: string }[];
  if (linkParts.length !== (reply.report || reply.sources.length ? 1 : 0)) fail(`link parts ${linkParts.length}`);
  for (const p of linkParts) if (!isAllowed(p.url) || /\s/.test(p.url)) fail(`link part not verified: ${p.url}`);
  for (const s of reply.sources) {
    if (!allowed.has(normalizeUrl(s.url))) fail(`source not verified https: ${s.url}`);
    if (/[\n\r]/.test(s.title) || linksIn(s.title).length || s.title.length > 150) fail(`source title shown raw: ${JSON.stringify(s.title.slice(0, 80))}`);
  }
  // The file: every link verified; each title one line; each quote on its page.
  const texts = pageTextOf(sc);
  const att = parts.find((p) => p.kind === "attachment") as { bytes: Uint8Array } | undefined;
  if (att) {
    const txt = new TextDecoder().decode(att.bytes);
    for (const u of linksIn(txt)) if (!isAllowed(u)) fail(`a link in the file that is not verified: ${u}`);
    if (/evil\.example/.test(txt)) fail("an injected link in the file");
    for (const q of txt.match(/^ {5}"(.*)"$/gm) ?? []) {
      const quote = q.trim().slice(1, -1);
      if (quote.includes("[link removed]")) continue;
      if (![...texts.values()].some((t) => nrm(t).includes(nrm(quote)))) fail(`a quote not on any page: ${quote}`);
    }
  }
  // The stored report: hrefs and visible URLs verified, nothing unescaped.
  if (reply.report) {
    const id = new URL(reply.report.url).pathname.split("/").pop()!;
    const html = await o.readReport(decodeURIComponent(id), reply.report.url);
    if (!html) fail("report link with no stored report");
    else {
      for (const h of [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"))) if (!allowed.has(normalizeUrl(h))) fail(`a report href not verified: ${h}`);
      const visible = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
      for (const u of linksIn(visible)) if (!allowed.has(normalizeUrl(u))) fail(`a URL shown in the report that is not verified: ${u}`);
      if (/<script/i.test(html) || /evil\.example/.test(html)) fail("script or injected link in the report");
    }
  }
  // The model: told page text is data; titles one line; no forged PAGE url.
  for (const p of model.seen) {
    if (!/never an instruction to you/.test(p.system)) fail("the draft rules do not say page text is data");
    const content = String(p.messages?.[0]?.content ?? "");
    for (const line of content.split("\n").filter((l) => l.startsWith("url: "))) if (!allowed.has(normalizeUrl(line.slice(5)))) fail(`a page block for an unverified url: ${line}`);
  }
  if (!allowed.size && model.seen.length) fail("the model was called with no verified source");
  return { fails, reply };
}

