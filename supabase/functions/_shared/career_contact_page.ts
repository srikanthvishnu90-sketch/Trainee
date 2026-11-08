// CONTACT OUTREACH (release 9 workstream E, proposal D-042), the contact File page: who the person is and why they are
// relevant, 5 to 10 cited professional facts with their dates, the address with its confidence and how it was found, and
// the draft exactly as it would go. Built on the shared File design (file_design.ts) and the brand tokens (brand.ts, PLUM).
// Nothing private: only the kept professional facts (career_contact_facts.ts already dropped home address, family,
// health, religion and politics), never the evidence internals (RCPT answers, the probe), never the person's own data
// beyond their first name. The page carries its expiry and is never indexed.
import { FAVICON, FONT_LINKS, TOKENS_CSS } from "./brand.ts";
import { esc, evidenceHtml, FILE_CSS, fileShellHtml, madeForLine, rowsSectionHtml, sectionHtml, stated, unknown } from "./file_design.ts";
import type { ContactDraft, ContactIn } from "./career_contact_draft.ts";
import type { ContactCard } from "./career_contact_send.ts";

export const PAGE_FACTS_MIN = 5, PAGE_FACTS_MAX = 10;
const SOURCE_WORDS: Record<string, string> = { company_page: "Company page", personal_page: "Their own site", sec_edgar: "SEC filing", github: "GitHub", openalex: "OpenAlex",
  semantic_scholar: "Semantic Scholar", uspto: "USPTO patent", conference: "Conference page", news: "News" };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const PAGE_CSS = `.why{margin:0 0 16px;color:var(--ink)}.draft{white-space:pre-wrap;font:inherit;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0;overflow-wrap:anywhere}
.dsub{font-weight:600;margin:0 0 8px}.fineprint{color:var(--mute);font-size:.875rem;margin:8px 0 0}.foot{max-width:720px;margin:24px auto;padding:0 16px;color:var(--mute);font-size:.875rem}`;

export function contactPageHtml(o: { contact: ContactIn; draft: ContactDraft | null; card?: ContactCard | null; firstName: string | null; now: number; tz?: string | null; expiresAt: string; why?: string | null }): string {
  const c = o.contact, p = c.person;
  const facts = [...c.facts].sort((a, b) => b.confidence - a.confidence).slice(0, PAGE_FACTS_MAX);
  const factsHtml = facts.map((f) => evidenceHtml({ quote: f.claim, source: `${SOURCE_WORDS[f.source_type] ?? "Public page"} · ${host(f.source_url)}${f.quote_snippet && f.quote_snippet !== f.claim ? ` · "${f.quote_snippet}"` : ""}`,
    at: f.published_at ?? f.retrieved_at ?? null, href: f.source_url, hrefLabel: "Source" }, o.tz)).join("");
  const thin = facts.length < PAGE_FACTS_MIN ? { text: `Only ${facts.length} public professional fact${facts.length === 1 ? "" : "s"} could be cited, so this is all there is.` } : null;
  const e = c.email, card = o.card && o.card.ok ? o.card : null;
  const emailRows = rowsSectionHtml("Email", [{
    name: e.email ?? "No address found", detail: `${e.score}/100 · ${e.why}`,
    value: e.approvable && e.email ? stated(`Confidence ${e.score}`, "From Trainee's records") : unknown(`Unconfirmed (${e.score}/100): not sendable`),
  }], e.approvable ? (card?.test_mode ? { title: "Test mode", text: `This email would go to ${card.to} (an owner test address), not to ${e.email}.` } : null)
    : { title: "Unconfirmed", text: "This address can't be confirmed, so it won't be sent to. Try an introduction through someone you know there, or the company's contact form." });
  const draftHtml = o.draft ? sectionHtml("The email, exactly as it would go", `<p class="dsub">Subject: ${esc(o.draft.subject)}</p><pre class="draft">${esc(card ? card.mails[0].text : o.draft.body)}</pre>`
    + `<p class="fineprint">Opens with fact ${o.draft.hook}: ${esc(o.draft.hook_fact?.claim ?? "")}. Nothing is sent until you approve this exact email.</p>`) : "";
  const body = `<p class="why">${esc(o.why ?? `${p.title ? `${p.title} at ${p.company}` : `Works at ${p.company}`}.`)}</p>`
    + sectionHtml("What's public about their work", factsHtml, { caveat: thin }) + emailRows + draftHtml;
  const inner = fileShellHtml({ made: madeForLine(o.firstName, o.now, o.tz), eyebrow: "Contact", title: p.name, stamp: null, stampMissing: "Read from public pages", intro: null, body });
  const exp = new Date(o.expiresAt).toISOString().slice(0, 16).replace("T", " ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">`
    + `<title>${esc(p.name)} - Trainee</title>${FAVICON}${FONT_LINKS}<style>${TOKENS_CSS}${FILE_CSS}${PAGE_CSS}</style></head><body><div id="root">${inner}`
    + `<footer class="foot"><p>Expires ${esc(exp)} UTC. Every fact links to the public page it came from; say "forget ${esc(p.name)}" to delete this contact.</p></footer></div></body></html>`;
}
