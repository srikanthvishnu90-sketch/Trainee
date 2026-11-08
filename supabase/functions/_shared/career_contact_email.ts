// CONTACT OUTREACH (proposal D-042): a contact's work address, found in evidence order and checked without sending.
//   1. published   an address on a first-party page for this person (the company's own pages, their own site), or the
//                  email on their public GitHub profile;
//   2. pattern     the domain's format learned from 2+ addresses the domain itself publishes;
//   3. finder      a free-tier finder (Hunter or Snov) only with the person's OWN key (default off; Trainee holds none);
//   4. fallback    a size-based pattern guess.
// Checks: syntax, MX (DNS over HTTPS) and the mail provider the MX names. An SMTP RCPT probe is pluggable and OFF by
// default (RCPT_PROBE_OFF): cloud hosts block outbound port 25, so a real probe needs a dedicated sender host the owner
// runs; it is never pointed at Google or Microsoft (they accept every RCPT, and probing them looks like abuse), and a
// catch-all domain is detected first with one random address. No test email is ever sent.
// The score (0-100) is the evidence's; only SEND_MIN_SCORE (70) or more can be approved for sending. Below it the address
// is shown as unconfirmed, with another channel suggested.
import { type MxResolver } from "./career_contacts.ts";

export type EmailMethod = "first_party_published" | "github_public" | "pattern_rcpt_valid" | "finder_verified" | "pattern_unverified" | "guess";
export const SCORE: Readonly<Record<EmailMethod, number>> = Object.freeze({
  first_party_published: 95, github_public: 90, pattern_rcpt_valid: 80, finder_verified: 75, pattern_unverified: 50, guess: 30,
});
export const SEND_MIN_SCORE = 70;
export const METHOD_WORDS: Record<EmailMethod, string> = {
  first_party_published: "published on their company's or their own page", github_public: "on their public GitHub profile",
  pattern_rcpt_valid: "the company's address format (seen 2+ times), accepted by its mail server", finder_verified: "a finder you connected, verified",
  pattern_unverified: "the company's address format, not confirmable on this mail server", guess: "a guess from the company's size",
};
export const UNCONFIRMED_NEXT = "I can't confirm this address, so I won't send to it. Try an introduction through someone you know there, or the company's own contact form.";

export type MailProvider = "google" | "microsoft" | "other" | "none" | "unknown";
export function providerOf(hosts: string[]): MailProvider {
  const h = hosts.map((x) => x.toLowerCase());
  if (h.some((x) => /(?:^|\.)(?:google\.com|googlemail\.com)$/.test(x))) return "google";
  if (h.some((x) => /(?:^|\.)(?:outlook\.com|protection\.outlook\.com|hotmail\.com)$/.test(x))) return "microsoft";
  return h.length ? "other" : "none";
}
export type Rcpt = "accept" | "reject" | "unknown";
// The seam a dedicated sender host plugs in (SMTP HELO, MAIL FROM <>, RCPT TO, QUIT: never DATA).
export interface RcptProbe { name: string; on: boolean; probe(email: string, mxHosts: string[]): Promise<Rcpt> }
export const RCPT_PROBE_OFF: RcptProbe = { name: "off", on: false, probe: async () => "unknown" };
export interface Finder { name: "hunter" | "snov"; find(first: string, last: string, domain: string): Promise<{ email: string; verified: boolean } | null> }
// Hunter's free tier, with the person's own key (default off). Its email-finder answers an address and a verification.
export function hunterFinder(o: { fetch: typeof fetch; apiKey: string | null | undefined }): Finder | null {
  if (!o.apiKey) return null;
  return { name: "hunter", async find(first, last, domain) {
    const r = await o.fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${encodeURIComponent(o.apiKey!)}`);
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null))?.data;
    return d?.email ? { email: String(d.email).toLowerCase(), verified: d?.verification?.status === "valid" } : null;
  } };
}

// ------------------------------------------------------------------------------------------------ formats
export const FORMATS = ["first.last", "firstlast", "flast", "f.last", "first_last", "first-last", "first", "last", "lastf", "last.first"] as const;
export type Format = typeof FORMATS[number];
const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
export function nameParts(full: string): { first: string; last: string } | null {
  const p = full.replace(/\b(?:dr|mr|mrs|ms|prof|jr|sr|ii|iii|phd|md)\b\.?/gi, "").trim().split(/\s+/).map(ascii).filter(Boolean);
  return p.length >= 2 ? { first: p[0], last: p[p.length - 1] } : null;
}
export function localFor(f: Format, n: { first: string; last: string }): string {
  const { first: a, last: b } = n;
  return ({ "first.last": `${a}.${b}`, firstlast: `${a}${b}`, flast: `${a[0]}${b}`, "f.last": `${a[0]}.${b}`, first_last: `${a}_${b}`, "first-last": `${a}-${b}`, first: a, last: b, lastf: `${b}${a[0]}`, "last.first": `${b}.${a}` } as Record<Format, string>)[f];
}
// The formats an address fits, given the name it belongs to (from the same page).
export function formatsOf(local: string, n: { first: string; last: string }): Format[] { return FORMATS.filter((f) => localFor(f, n) === local.toLowerCase()); }
// The domain's format from addresses it publishes with a name beside them: a format seen 2+ times, the most seen.
export function learnFormat(named: { email: string; name: string }[], domain: string): { format: Format; evidence: number } | null {
  const count = new Map<Format, number>(), seen = new Set<string>();
  for (const x of named) {
    const e = x.email.trim().toLowerCase(); if (seen.has(e)) continue; // one address is one piece of evidence, however often it is published
    const [local, d] = e.split("@"); const n = nameParts(x.name);
    if (d !== domain.toLowerCase() || !n) continue;
    seen.add(e);
    for (const f of formatsOf(local, n)) count.set(f, (count.get(f) ?? 0) + 1);
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1] || FORMATS.indexOf(a[0]) - FORMATS.indexOf(b[0]))[0];
  return best && best[1] >= 2 ? { format: best[0], evidence: best[1] } : null;
}
// A size-based guess when nothing was learned: small companies tend to first name, larger ones first.last.
export const sizeFormat = (employees: number | null | undefined): Format => (employees != null && employees < 50 ? "first" : "first.last");

// ------------------------------------------------------------------------------------------------ the evidence
export const SYNTAX = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
export interface EmailEvidence {
  email: string | null; method: EmailMethod | null; score: number; approvable: boolean; why: string;
  syntax: "pass" | "fail"; mx: "pass" | "fail" | "unknown"; provider: MailProvider; catch_all: boolean | null; rcpt: Rcpt | "not_probed";
  source_url: string | null; format: Format | null; format_evidence: number; checked_at: string;
}
export interface FindIn {
  name: string; domain: string; now: number;
  published?: { email: string; source_url: string }[]; // addresses a first-party page published for THIS person
  github?: { email: string; source_url: string } | null;
  domainNamed?: { email: string; name: string }[];      // every named address the domain publishes (for the format)
  employees?: number | null; mx: MxResolver; probe?: RcptProbe; finder?: Finder | null; random?: () => string;
}
const score = (m: EmailMethod | null, mx: EmailEvidence["mx"]) => (m && mx !== "fail" ? SCORE[m] : 0);
export async function findEmail(i: FindIn): Promise<EmailEvidence> {
  const domain = i.domain.toLowerCase(), probe = i.probe ?? RCPT_PROBE_OFF, at = new Date(i.now).toISOString();
  const check = async (d: string) => {
    const r = await i.mx(d);
    return { hosts: r.status === "ok" ? r.hosts : [], mx: (r.status === "ok" ? "pass" : r.status === "none" ? "fail" : "unknown") as EmailEvidence["mx"],
      provider: (r.status === "ok" ? providerOf(r.hosts) : r.status === "none" ? "none" : "unknown") as MailProvider };
  };
  const own = await check(domain), hosts = own.hosts, mx = own.mx, provider = own.provider;
  // An address is approvable only when its OWN domain has a mail server: a published or GitHub address on another domain
  // gets that domain's MX and provider looked up, never the employer's borrowed.
  const out = async (email: string | null, method: EmailMethod | null, extra: Partial<EmailEvidence> = {}): Promise<EmailEvidence> => {
    const syntax = email && SYNTAX.test(email) ? "pass" : "fail";
    const addrDomain = email && syntax === "pass" ? email.split("@")[1] : null;
    const c = addrDomain && addrDomain !== domain ? await check(addrDomain) : { mx: addrDomain ? mx : "unknown" as EmailEvidence["mx"], provider };
    // The evidence score is about where the address came from; a missing mail server on the employer's own domain zeroes
    // it (nothing there can receive mail), and on any domain it blocks approval: approvable needs that domain's MX to pass.
    const s = syntax === "pass" ? score(method, addrDomain === domain ? c.mx : "unknown") : 0;
    const why = method ? (c.mx === "pass" ? METHOD_WORDS[method] : `${METHOD_WORDS[method]}; no mail server confirmed for ${addrDomain ?? "it"}`) : "no address found";
    return { email, method, score: s, approvable: s >= SEND_MIN_SCORE && c.mx === "pass", why, syntax, mx: c.mx, provider: c.provider, catch_all: null, rcpt: "not_probed",
      source_url: null, format: null, format_evidence: 0, checked_at: at, ...extra };
  };
  const pub = (i.published ?? []).find((p) => SYNTAX.test(p.email.toLowerCase()));
  if (pub) return await out(pub.email.toLowerCase(), "first_party_published", { source_url: pub.source_url });
  if (i.github && SYNTAX.test(i.github.email.toLowerCase())) return await out(i.github.email.toLowerCase(), "github_public", { source_url: i.github.source_url });
  const n = nameParts(i.name);
  if (!n) return await out(null, null);
  const learned = learnFormat(i.domainNamed ?? [], domain);
  let pattern: EmailEvidence | null = null;
  if (learned) {
    const email = `${localFor(learned.format, n)}@${domain}`;
    const fmt = { format: learned.format, format_evidence: learned.evidence };
    if (probe.on && provider === "other" && mx === "pass") {
      // Catch-all first: only a server that explicitly REJECTS a made-up address can vouch for an accepted one. An
      // unknown answer leaves catch_all unknown (null) and the person's address unprobed and unverified.
      const rnd = `${(i.random ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 16)))()}@${domain}`;
      const r0 = await probe.probe(rnd, hosts);
      const catchAll = r0 === "accept" ? true : r0 === "reject" ? false : null;
      const rcpt: Rcpt = catchAll === false ? await probe.probe(email, hosts) : "unknown";
      if (rcpt === "reject") pattern = { ...(await out(email, "pattern_unverified", { ...fmt, catch_all: catchAll, rcpt })), score: 0, approvable: false, why: "the company's mail server refused this address" };
      else pattern = await out(email, catchAll === false && rcpt === "accept" ? "pattern_rcpt_valid" : "pattern_unverified", { ...fmt, catch_all: catchAll, rcpt });
    } else pattern = await out(email, "pattern_unverified", fmt);
    if (pattern.method === "pattern_rcpt_valid") return pattern;
  }
  if (i.finder) {
    const f = await i.finder.find(n.first, n.last, domain).catch(() => null);
    if (f?.verified && f.email.endsWith(`@${domain}`)) return await out(f.email, "finder_verified");
  }
  if (pattern) return pattern;
  return await out(`${localFor(sizeFormat(i.employees), n)}@${domain}`, "guess", { format: sizeFormat(i.employees) });
}
