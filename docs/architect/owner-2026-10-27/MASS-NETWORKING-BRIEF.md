# Mass networking — shared brief for builders (2026-10-27)

Repo srikanthvishnu90-sketch/upmore-agent, dev branch `trunk`. Read CLAUDE.md, AGENTS.md,
docs/architect/STRICT-STANDARD.md, and the rules section of
docs/architect/owner-2026-10-27/MASS-SUBMISSION-BRIEF.md
(environment notes, attribution, PR via gh REST, no deploys, nothing sent).

## Owner decisions, in writing today (2026-10-27 19:48 CDT, Vishnu, in chat with the architect)
- D-MN-1 Sending: Trainee SENDS personalized emails from the person's own Gmail (gmail.send scope, the person's
  own OAuth connection) after approval. Replaces "Trainee never sends" for outreach email. LinkedIn stays never
  automated; nothing is sent from any Trainee-owned address.
- D-MN-2 Approval: one yes approves exactly the batch of emails shown, each bound to the hash of its exact
  recipient + subject + body (same shape as D-MS-1 for applications). Subsets ("send all except 4", "only 1-10")
  approve only what's stated; ambiguous never approves; an email whose text changed after it was shown is not sent.
- D-MN-3 Finding people at scale: the person's own sources (LinkedIn export, Gmail, pages they send — PR #217 /
  people-finding v2) PLUS a people/email data provider (Hunter.io or Apollo; adapter interface so either fits).
  The provider is paid and needs an API key the owner supplies through secure storage — never in chat, repo or
  tests. Without the key the provider is NOT_WIRED and the reply says so plainly (repo rule: never fake a
  connector). LinkedIn/Indeed/Handshake are never fetched or automated.
- D-MN-4 Both cold outreach (email people at target companies) and introductions through mutual contacts
  (#217's intro path), at scale.

## Safety rules for sending at scale (architect, binding)
- Pacing per sender Gmail account (configurable, conservative default), spread over time; respect Gmail API
  errors/limits by backing off, never by retrying in a tight loop.
- Never email the same person twice except one approved follow-up; never email someone who replied "stop",
  "unsubscribe", "not interested" or similar (opt-out list per person, honored forever unless they re-ask).
- Bounces and hard failures recorded; a bounced address is never retried and is marked bad.
- Only verified-deliverable addresses from the provider (respect its confidence/verification field); never guess
  email patterns and send to them.
- Personalization uses only facts the person confirmed and facts about the recipient from the cited source;
  never invent (D-007). Every draft records its source per fact.
- Erase/disconnect: disconnecting Gmail stops all pending sends; "forget" removes outreach data.
- No real email is ever sent in tests: Gmail and the provider are faked at the HTTP boundary.

## Model calls
No model spend is approved right now. Drafting/personalization code calls the model through the existing
gateway; tests use the existing fake/scripted model. Live drafting waits for the owner's fresh key.
</content>

## SCALE REQUIREMENT (owner, 2026-10-27 19:52 CDT: "we need to be able to operate these things at large scale")
Binding for every mass-submission and mass-networking lane:
- Design target: 100,000 people active at once (98k waitlist), each able to run hundreds of applications and
  hundreds of outreach emails per day. Prove it with a measured load test, not a claim.
- No conservative product defaults. Pacing and budgets exist ONLY as technical/provider limits (portal rate
  limits, Gmail's own per-account sending ceiling, the data provider's rate limit and the owner's credit budget),
  each configurable, with defaults set at the real limit, not below it.
  Known hard ceiling: Gmail caps sending per account (Google Workspace documents 2,000 messages/day per user,
  500 on trial accounts; consumer gmail.com is lower). Sending from each person's own Gmail scales across people,
  but one person cannot exceed their own account's cap. Track it per account and say plainly when it's reached.
- Horizontal scale: queues claimed with `FOR UPDATE SKIP LOCKED` leases (or the repo's existing claim pattern),
  partitioned so many worker instances run in parallel with no single VM or single loop; every job idempotent;
  expired leases reclaimed; no global lock on the hot path.
- Database: every hot query indexed and bounded (no per-turn reads of hundreds of rows; the audit measured 600
  rows per turn); no large blobs in Postgres hot tables.
- Load test in CI-runnable form (real Postgres 16): e.g. 10,000 people × 50 queued items claimed by 20 concurrent
  workers → measure throughput/latency, assert exactly-once and fairness across people (one heavy user can't
  starve others). Report the measured numbers.

## NO LIMITS (owner, 2026-10-27 19:55 CDT: "no person limit, never set a limit") — supersedes the budget/pacing lines above
- Trainee sets NO volume limit of its own anywhere: no per-person daily cap, no per-person lookup budget, no
  per-run cap, no default pacing number. Remove any such constant you added.
- The only thing that slows work is an outside system refusing: a portal's 429/rate-limit or bot wall, Gmail's
  quota/limit errors, the data provider's 429 or out-of-credits. React to the refusal (back off, resume when the
  outside system allows, tell the person plainly what happened) — never pre-emptively cap.
- Not volume limits, so they stay: exactly-once, payload-hash approval, opt-out/"stop" honored, never emailing a
  bounced address, never duplicating an application to the same posting, resume required, no captcha solving,
  never automating LinkedIn/Indeed.

## Tonight's goal (owner, 2026-10-27 19:57 CDT)
Two features DONE tonight, tested Instinct-style (new-user scenarios on each channel, judged by real DB/outbox
state, not reply text): (1) mass application submission; (2) networking at scale. Networking sub-features in
scope now: connect Outlook (Microsoft Graph: mail read, send, calendar), find professional emails (provider + own
sources), send personalized emails (Gmail and Outlook), understand what happens (reply tracking/classification:
interested, not interested, wants a call, out of office, bounce), follow-ups, scheduling calls from the person's
calendar (Google Calendar / Outlook: free-busy → proposed slots → approved invite), and connecting LinkedIn /
Handshake data ONLY through the person's own export, sign-in identity or their alert emails — never automation
(owner rule, unchanged). Owner reversed "Microsoft later": Outlook is in scope now.
Migration ranges: A 14xxxx, N2 16xxxx, N1 17xxxx, M1 20xxxx, M2 21xxxx, M3 22xxxx, M4 23xxxx, M5 24xxxx, M6 25xxxx
(all 20261027 prefix).

## Owner answers (2026-10-27 ~20:40 CDT)
- Build ALL proposed networking features (NET-13..18 in PR #224's spec) after tonight's two, PLUS:
  "the ability to write any email" (general email composition for any purpose, from the person's own
  Gmail/Outlook, same fact-lock + approval + send rail) and "understand conversational workflow" (follow a whole
  email conversation over many turns: who said what, what's being asked, what the next step is, across threads).
- APL-12 YES: applications that are submitted by email go out from the person's own Gmail/Outlook, same batch
  yes + payload-hash approval, through the send rail.
- Cross-person recipient protection (D-018a "3 emails per address per 30 days across all users") REMOVED. Opt-out
  ("stop"/"unsubscribe"), never re-emailing a bounced address and exactly-once still stand (not volume limits).
- Provider: build adapters for BOTH Hunter and Apollo; the owner picks one when buying a plan.

## D-MN-3 REPLACED (owner, 2026-10-27 21:32 CDT): "don't use Hunter or Apollo ... so we can do it with anyone"
No paid people/email provider. Find people and professional emails the way a research agent does, for any company:
1. Discover people: web search through the model gateway (OpenAI's web search tool — OpenAI-only rule) with the
   repo's search recipe (company + function + office + "team"/"engineering manager"/"campus recruiting"/speaker),
   then read the underlying public pages with the existing SSRF-guarded page reader (robots honored, size/time
   bounded). Sources: company team/about pages, job postings naming a recruiter, engineering blogs, conference
   speaker pages, GitHub org/profile pages, papers/lab pages, press pages. LinkedIn/Indeed/Handshake pages are never
   fetched (a search result pointing there can be shown as text only). Each person keeps the source URL that
   establishes name + current employer.
2. Emails, in order of strength: (a) published on a public page (mailto / text) — "published"; (b) the person's own
   Gmail/Outlook correspondence — "known"; (c) inferred from the company's email format, learned from ≥2 published
   or known addresses at that exact domain (first.last, flast, first, etc.) — "inferred", with the evidence count;
   MX checked via DNS-over-HTTPS. No SMTP/RCPT probing (abusive; port 25 blocked anyway).
3. Learning at scale: per-domain format confidence is shared across all users (formats only, never another person's
   addresses or contacts) and updated from bounces and replies, so accuracy improves as volume grows.
4. Inferred addresses may be emailed after the person's approval; the card labels each address published/known/
   inferred. A bounce marks the address bad, lowers that domain format's confidence, and is never retried.
5. Never invent a person: a name needs a source page; no source → not stored.

## Owner answers (2026-10-27 22:34 CDT)
- Reading Gmail/Outlook replies and confirmations: build it now (gmail.readonly + Outlook Mail.Read). The beta runs
  with Google's 100-test-user cap; the restricted-scope security review (CASA) is deferred. Code must handle "not
  verified yet" honestly (unverified-app screen, the 100-user cap) — no workaround.
- Billing and cancelling by text: YES, add it (top competitor complaint). Plain pricing in chat, "what am I paying",
  "cancel my plan" works on every channel in one approved step, no dark patterns, receipts by text.
