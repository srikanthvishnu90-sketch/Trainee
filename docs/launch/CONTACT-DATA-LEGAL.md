# Contact data sources: what is allowed, what is not, and how it is enforced

Written 2026-10-30. **These are engineering notes, not legal advice.** The owner should have counsel review this document,
the allowlist, and the outreach templates before any mass outreach. Nothing here has been reviewed by a lawyer.

Code: `supabase/functions/_shared/contact_sources/` (entry point `mod.ts`). Tests: `tests/edge/contact-sources.test.ts`
(fixtures in `tests/fixtures/contact_sources/`, no live network).

## The interface the outreach code uses

```ts
import { importContacts, SuppressionList, emailEligibility } from ".../contact_sources/mod.ts";
const { contacts, rejected, suppressed } = importContacts(candidates, { suppression, existing });
const ok = emailEligibility(contact, suppression); // { ok, reason }; never builds an address
```

`Contact`: name, role_title, role_family, firm, location, education[], shared_connections[], email + email_basis, and
`provenance[]` (source_kind, source_url, retrieved_at, license_note). A contact with no complete provenance is rejected.

## Hard rules and where each is enforced

| Rule | Enforcement |
|---|---|
| No LinkedIn, Indeed, Handshake (also Glassdoor, ZipRecruiter) scraping or automation | `isBlockedHost` refuses them as a fetch target (even if someone lists them in the allowlist) and as a `source_url`. A profile-URL column in a user export is dropped, never stored, never visited. |
| SSRF / redirects | `WebGate` refuses non-https, userinfo, non-443 ports, IP-literal hosts, localhost/.local/.internal names, and anything but an exact allowlisted hostname; an optional resolver rejects private/link-local/loopback answers; redirects are never followed by the fetcher (`redirect: "manual"`): the gate re-validates every hop (allowlist, blocklist, robots), max 3 hops. |
| No captcha bypass, no scraping behind logins | `WebGate` sends no cookies or credentials, stops on 401/403, a redirect to a login path, or a password field, and refuses redirects off the host. There is no captcha code. |
| robots.txt and per-site terms | `WebGate.fetchText`: host must be on a `SiteRule` allowlist (default list is empty = default deny); the rule records the terms URL, who read them, and when; a review older than 365 days is refused; robots.txt is read once per host and must allow our agent for the path (longest-match, Allow wins ties, wildcards, specific-agent group wins over `*`); unreadable robots (401/403/429/5xx/error) = deny; 404 = no restrictions per RFC 9309; Crawl-delay honored; per-host pacing. |
| No guessed email | An address needs `email_basis` in `published_on_source` (inside that person's own card on the page), `user_supplied`, or `licensed_verifier` (the provider's own "valid"/"verified" verdict). No code constructs an address from a name and a domain; a test checks the source. |
| Provenance on everything | `toContact` rejects missing source_url, retrieved_at or license_note. |
| Suppression | `SuppressionList`: opt-out by email, name (all firms) or name + firm; applied after dedupe so a name-only copy of an opted-out person is caught; JSON round trip for storage; `importContacts` takes it on every call, including against `existing`. |

## Sources, and what each one actually gives

| Adapter | Gives | Does not give | Terms posture |
|---|---|---|---|
| User CSV / LinkedIn data export (the user's own file) | Whatever the user exported: name, company, position, connected-on; email only where the member's contact allowed it; optional columns for location, education, shared connections | No profile fetching | The user's own data. Use it to help that user network. LinkedIn's export terms are the user's to read; we do not call LinkedIn. |
| Pasted names | Name, optional role/firm/email the user typed | | User's own input |
| SEC EDGAR Forms 3/4/5 | Officer/director name, title, issuer | Email, home address (we drop addresses), anyone below officer level | Public record. SEC fair access: declared User-Agent with a real contact email (`validSecUserAgent`), under 10 requests/second (paced at 150 ms+). |
| Firm "team/people" pages | Name, title, office, bio education, email when shown with a mailto | Anything off the page | Only sites a human reviewed (allowlist) and whose robots.txt allows us |
| University faculty/staff directories | Name, rank, department, degrees, published email | Students (never) | Same gate. Many universities restrict directory use for solicitation; reading the terms per site is the whole point of the allowlist. FERPA covers student records, so student directories are out of scope. |
| Conference speaker pages | Name, title, company | Email (rarely published) | Same gate |
| Licensed provider (OFF) | See below | | Contract |

### Licensed provider adapter: OFF until the owner acts

`licensedAdapter(config)` returns `{enabled:false, reason}` unless there is an API key **and** the owner has recorded a
signed contract (date, signer, permitted-use sentence taken from the contract) and the provider's terms URL. It knows no
provider endpoint: a provider is a small object with `search()`, written after the contract exists, so no unlicensed call
can be made by accident. Candidates: **People Data Labs**, **Apollo**, **Hunter** (the repo already uses Apollo CSV export
plus Hunter verification: `docs/career/contact-vendors.md`). **The owner must read and sign the chosen provider's terms
himself**; check specifically whether outreach/storage/resale are permitted and what the provider says about EU/California
data subjects. Only an email the provider itself marks valid/verified is kept (accept_all and unknown drop the address, keep
the person). Provenance records the contract date and permitted use on every record.

## Engineering notes on email law (not legal advice; counsel to confirm)

**CAN-SPAM (US, commercial email).** Applies to commercial messages including B2B. Practical requirements: no false or
misleading headers (From, Reply-To and routing must be honest and identify the sender); no deceptive subject line; identify
the message as an ad where required; include a valid physical postal address of the sender; include a clear way to opt out,
honored within 10 business days, with the opt-out working for at least 30 days after sending; do not sell or transfer an
opted-out address; the sender is responsible even if a vendor sends. Hook for engineering: an opt-out reply or link must call
`SuppressionList.suppress({email, name, firm})` and the list must be persisted (store `toJSON()` in a table; this PR adds no
migration so as not to collide with the networking builder's schema).

**CCPA/CPRA (California residents).** Contacts are personal information even in a work context (the B2B exemption expired
in 2023). If the business meets the thresholds: notice at collection, a way to learn what was collected and its source
(provenance helps), delete on request, opt out of sale/sharing, no discrimination. The suppression list is the deletion
record: keep a minimal key so the person is not re-imported. Needs counsel to decide whether the owner's business is covered.

**Others to ask counsel about:** GDPR/UK GDPR if any contact is in the EU/UK (lawful basis, Art. 14 notice, PECR/ePrivacy
rules on B2B email vary by country); CASL (Canada) requires consent for most commercial messages; state laws; the Gmail/Yahoo
bulk-sender rules (SPF/DKIM/DMARC, one-click unsubscribe) which are deliverability rules, not statutes. LinkedIn, Indeed and
Handshake prohibit scraping in their terms; US courts have gone both ways on scraping public data, and contract and
computer-misuse claims are still live, so the rule here is simply do not.

**Outreach copy rules the networking builder should apply:** a real sender identity, an honest subject, the physical address
in the footer, a working one-click opt-out, and the reason this person was contacted (the source) available on request.

## Honest list of legally scalable sources by role family

| Family | What exists at scale |
|---|---|
| Finance | SEC EDGAR insider filings (officers/directors, public companies), FINRA BrokerCheck and SEC IAPD adviser data (public regulator lookups; check their terms before bulk use), firm team pages, licensed data vendors. Junior bankers are mostly reachable only via the user's own network or a licensed provider. |
| Tech | Company team/about pages, conference speaker pages, EDGAR for executives of public companies, open-source maintainer pages the person chose to publish, licensed providers. |
| Healthcare | NPI registry (CMS NPPES, public: name, specialty, practice address, no email), hospital and medical-school faculty directories, conference speaker pages, state license lookups (terms vary by state). |
| Law | State bar attorney directories (public, per-state terms and often anti-solicitation limits), law-firm attorney bio pages (the best source, they publish emails), law-school faculty pages, licensed providers. |
| Education | University and K-12 faculty/staff directories (published emails, terms vary; never students), conference speaker pages. Best-covered family at scale. |
| Trades | Thin: state contractor-license lookups (name, license, business address), union locals and trade association member pages, licensed providers. Most tradespeople are not on the web as individuals; expect the user's own network to dominate. |

None of these gives Mapped-style "shared connections" at scale without the user's own data: shared connections come only from
the user's own export or paste, never inferred.

## Coverage from fixtures (14 contacts after dedupe)

Fixtures are tiny and invented; this shows how the pipeline fills fields, not real-world coverage.

| Field | Filled |
|---|---|
| role_title | 13/14 (93%) |
| firm | 14/14 (100%) |
| location | 7/14 (50%) |
| education | 5/14 (36%) |
| shared_connections | 2/14 (14%) |
| email | 3/14 (21%): 2 published on source, 1 user supplied |

Provenance: 14/14. Role families covered: finance, tech, healthcare, law, education, trades. Real coverage must be measured
after the owner's first allowlisted crawl and first provider contract.

## Owner checklist before mass outreach

1. Counsel review of this document, sender identity, physical address and unsubscribe flow.
2. For each web source: read the site's terms and robots.txt, then add a `SiteRule` (default list is empty).
3. Choose and sign with a licensed provider if wanted; enter the contract details.
4. Persist the suppression list and wire opt-out replies/links to it.
