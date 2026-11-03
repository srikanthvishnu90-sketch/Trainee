# Google OAuth verification and CASA, ready to submit (2026-10-26)

Owner decision, in writing, 2026-10-26: **"yes start google's verification"**.

This file holds everything Google asks for, as text you can paste. It covers the scope analysis (§1), Google's requirements with
sources (§2), what this PR changed in the code so the policy is true (§3), the blockers that must clear before you submit (§4),
and your click path with every value (§5). Nothing here has been submitted to Google. No DNS, Vercel or Google Cloud setting
was changed.

**Launch hold (owner, in writing, 2026-10-26 14:14 CDT):** no deploys, no Vercel or DNS changes, no Vercel sandbox use
without the owner's approval, and no pushes to release/production. Every deploy, domain, DNS and Vercel step below waits for
the owner's go. This PR changes code and docs only.

**Owner inputs, not invented here.** These three go in `docs/launch/legal-pages/owner-inputs.json`:

- `LEGAL_NAME`: the legal entity that runs Trainee;
- `SUPPORT_EMAIL`;
- `GOVERNING_STATE`.

Today all three are null, so `scripts/launch/build-legal-pages.ts` refuses to build. It exits 1, names each missing input
and writes nothing. The legal pages therefore stay unpublished: their templates live in `docs/launch/legal-pages/`, outside
the served `site/` folder, and no file under `site/` carries a placeholder (`google-verification.test.ts` GV/11).

`{{DOMAIN}}` in this document means the domain you buy (§4.1).

---

## 0. The answer in five lines

- **Scopes to submit:** `openid`, `email` (non-sensitive) and `https://www.googleapis.com/auth/gmail.readonly` (restricted).
  **gmail.send: Deferred** to a later submission. **Calendar: dropped.**
- **CASA can't be avoided** if Trainee reads any Gmail at all. Both Gmail features (emailed codes and application tracking)
  need a restricted scope (§1.4).
- **Hard blocker: Trainee has no domain of its own.** It is served at `trainee-six.vercel.app`, and the Google callback is at
  `mrwngntwmnaqrqhupvlt.supabase.co`. Google requires every authorized domain to be verified by you in Search Console, and
  you can't put a DNS record on `vercel.app` or `supabase.co` (§4.1).
- **Owner inputs:** the legal pages can't be published until you fill the legal name, support email and governing state.
  The build refuses until then (§5 step 0).
- **Second blocker: the demo video must show both features working,** and today neither is deployed. `career-email-code` and
  `career-connect` are not deployed, and mail tracking's switch is off (§4.3).
- **Cost and time:** Google charges nothing. The CASA lab costs about $540 to $720 at TAC Security (Aug 2025 list prices);
  others range from about $700 to $3,000 or more. Google estimates about 6 weeks for restricted-scope verification, "not
  guaranteed". Practitioners report 5 to 20 days from Google's CASA email to approval. Realistically that is about 30 to 50
  days from today if the domain and the deploys happen in the first week (§2.7).

---

## 1. Scope minimization

### 1.1 Every Google scope the code asks for today (trunk `fe8405586`, plus open PR #191)

| Where | Scopes asked | Who calls it |
|---|---|---|
| `supabase/functions/gmail-oauth/career.ts:13-17` (`start_career`, provider `google_career`) | gmail.readonly, gmail.send, calendar.freebusy, calendar.events | **No client calls it** (connectors audit 2026-10-26, row 2) |
| `gmail-oauth` `start` (legacy finance grant, provider `gmail`) | gmail.readonly | The Upmore finance app (live v26; 0 rows ever). **Off after this PR:** it answers 410 unless `UPMORE_LEGACY_GMAIL_CONNECT=on`, and a legacy callback is not stored. Its reader, `agent-exec` (`format=full`), is a finance-era leftover outside Trainee's policy. You may retire it; it can't get a new grant through this app |
| PR #191 `_shared/career_connectors.ts:98` (`career-connect`, one-time link from any channel) | gmail.readonly and/or gmail.send per need, plus `openid email` | "connect gmail" in chat (not merged) |
| `_shared/career_mail_gmail.ts` (WO-024 mail tracking, F8) | uses gmail.readonly | `career-proactive` (not deployed; `CAREER_MAIL_TRACKING` off) |
| `_shared/career_email_code.ts` (WO-096 emailed codes) | uses gmail.readonly | `career-email-code` (not deployed) |
| `_shared/career_mail_gmail.ts` `sendMail` (WO-032 apply by email) and F8 follow-ups | uses gmail.send | `agent-chat`, only with `CAREER_EMAIL_SEND=on` (off) |
| `_shared/career_outreach_gmail.ts` (WO-033 outreach) | uses gmail.send, gmail.readonly (reply threads) | `career-proactive`, only with `CAREER_OUTREACH_SEND=on` (off) |
| Calendar | none | **Nothing calls the Calendar API** (`_shared/career_capabilities.ts:5`) |

After this PR, every consent URL from `gmail-oauth` goes through `requestScopesFor` (`gmail-oauth/career.ts`). That function
is in lockstep with `_shared/google_scopes.ts` `requestableScopes`. So the request can carry only `openid email gmail.readonly`.
gmail.send is added only when you set `GOOGLE_APPROVED_EXTRA_SCOPES`, and Calendar is never added
(`tests/architect/google-verification.test.ts` GV/1 to GV/4).

### 1.2 The final set

| Scope | Class | Feature (live path) | Why nothing narrower works | Retention rule |
|---|---|---|---|---|
| `openid` | non-sensitive | Identifies the Google account that granted access | Already the minimum | The address is stored on the connection row until disconnect |
| `email` | non-sensitive | Shows the person which address they connected ("Gmail connected: you@gmail.com") | Already the minimum. Without it, the userinfo call in `gmail-oauth/index.ts` has no permission and the address is lost | As above |
| `https://www.googleapis.com/auth/gmail.readonly` | restricted | (1) **Emailed security codes:** during an application the person approved, Trainee reads the code Greenhouse, Lever, Ashby or Workday emails them and types it into that form (`career_email_code.ts`, `format=full`, sender-restricted, Gmail-authenticated, 15-minute window). (2) **Application tracking:** Trainee reads the From, Subject and Date headers and Gmail's snippet of new mail (`career_mail_gmail.ts`, `format=metadata`) to update the stage of each application | See §1.3 | Codes are never stored (an `EmailCode` prints as "[emailed code]"). Message content is held in memory for the run only. Kept until disconnect, "forget everything" or account deletion: per employer email, the kind, company, role, an evidence line of 300 characters or less (no runs of 6 or more digits), a SHA-256 of the message ID, and the date (`career_mail_events`); drafts made from them; the read cursor. Tokens are kept in Supabase Vault until disconnect |
| `https://www.googleapis.com/auth/gmail.send` | sensitive | Apply by email, F8 follow-ups, outreach | Not needed at launch | **Deferred.** Every sender is behind an owner switch that is off, and no sender is deployed. Google rejects scopes for "future enhancements" ([requirements](https://support.google.com/cloud/answer/13464321)). Until it is approved, send through a prefilled Gmail compose link the person sends themselves (connectors research §6) |
| `calendar.freebusy`, `calendar.events` | sensitive | None | n/a | **Dropped.** No code reads or writes Calendar |

### 1.3 Why narrower Gmail access fails

- **`gmail.metadata`** is also restricted, so it would not avoid CASA ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)).
  It returns headers and labels without the body, so a security code inside the body can't be read. It also doesn't allow
  the `q` search parameter. Both readers search with `q`: the code reader uses `from:(greenhouse-mail.io …) after:<t>`, and
  the tracker uses `after:<t> -in:sent -in:drafts -in:chats`.
- **`gmail.labels`** (non-sensitive) gives labels only, no messages.
- **No per-message picker exists for Gmail.** The Google Picker plus `drive.file` is per-file for Drive only. Gmail add-on
  "current message" scopes work only while the person has that one message open inside Gmail. A code must be read while
  an approved application runs in the background, and replies must be tracked without the person opening each one.
- **IMAP/SMTP over OAuth** needs `https://mail.google.com/`, the broadest restricted scope.

### 1.4 Can a feature be dropped or deferred to avoid CASA?

No, not while Trainee reads any Gmail. Both features need a body or snippet read, and every scope that reads message content
is restricted. These are the CASA-free alternatives that already exist:

- the person types the code ("type it yourself", `career_email_code.ts` `codeStop`);
- the person tells Trainee the outcome;
- Outlook, through Microsoft's own verification, which is separate.

A forwarding address was considered and rejected by the owner's 2026-10-26 decision ("no Trainee-provided application email
address"). The decision recorded here is to submit gmail.readonly and do CASA Tier 2, and to defer gmail.send so it adds no
risk to the first review.

---

## 2. Google's requirements, checked 2026-10-26, with the text to submit

Sources (fetched 2026-10-26):

- [Verification requirements](https://support.google.com/cloud/answer/13464321) (VR)
- [Manage OAuth App Branding](https://support.google.com/cloud/answer/15549049) (BR)
- [Verification FAQ](https://support.google.com/cloud/answer/13463817) (FAQ)
- [Security assessment](https://support.google.com/cloud/answer/13465431) (SA)
- [API Services User Data Policy, last updated Feb 15, 2024](https://developers.google.com/terms/api-services-user-data-policy) (UDP)
- [Workspace API User Data and Developer Policy, last updated 2026-09-03](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) (WDP)

### 2.1 Homepage on a verified domain

- **Requirement (VR, BR).** The homepage must be "hosted on a verified domain you own". It must identify the app, describe
  what it does, and "can not be only a login page". It must link the privacy policy, and that link must match the consent
  screen's.
- **Value.** `https://{{DOMAIN}}/`, which is `site/index.html`. It describes Trainee. After this PR, its footer, its sign-up
  consent line and its help pages link `/privacy` and `/terms`.
- **Today.** It is served only at `trainee-six.vercel.app` (Vercel project `trainee`, production from `main` @ `b09c3c57`).
  The project's `ssoProtection` is `all_except_custom_domains` (read with the Vercel MCP, 2026-10-26). A custom domain is
  also what Vercel exempts from that protection, so one domain fixes both problems.

### 2.2 Privacy policy (with the Limited Use statement) and terms

- **Requirement.** The privacy policy must be hosted on the homepage's domain and linked from the homepage and the consent
  screen (VR, BR). It must disclose how Google user data is accessed, used, stored and shared (VR). Per the FAQ and WDP, it
  must also carry "an affirmative ... statement that your use of the data complies with the Limited Use restrictions", and
  Workspace data may not train AI/ML models.
- **Values.**
  - Privacy policy: `https://{{DOMAIN}}/privacy`. Built to `site/privacy.html` from
    `docs/launch/legal-pages/privacy.template.html`. The Google section is `#google`; the statement is `#limited-use`.
  - Terms: `https://{{DOMAIN}}/terms`, built from `terms.template.html`.
  - Pre-consent explanation, public copy: `https://{{DOMAIN}}/google`, built from `consentNotice`.
  - The same build points the homepage's legal links and help pages at these pages. Until then, the homepage stays as it
    is on trunk.
- **The Limited Use statement, as published:**

  > Trainee's use and transfer to any other app of information received from Google APIs will adhere to the Google API
  > Services User Data Policy, including the Limited Use requirements. The use of information received from Google
  > Workspace APIs will also adhere to the Google Workspace API User Data and Developer Policy. Google user data is never
  > used to create, train or improve a machine learning or artificial intelligence model.

- **Owner-confirm items.** These are commitments, not code. Read them before publishing:
  - "no person at Trainee reads your email" except the listed exceptions;
  - minimum age 13;
  - "we will tell you" of a breach;
  - account deletion on request by email;
  - the governing law.

### 2.3 Branding fields (Google Auth Platform → Branding)

| Field | Value |
|---|---|
| App name | `Trainee` (shown only after verification, BR) |
| User support email | `{{SUPPORT_EMAIL}}`. It must be your Google account's address or a Google Group you manage (BR). A Google Group such as `trainee-support@googlegroups.com` works without Workspace |
| App logo | `site/brand/trainee-logo-120.png` (120×120 PNG, 1.5 KB: white "t" on plum #4A2F5E, the site's colors). It is a candidate: replace it if branding settles. Uploading a logo starts brand verification, which happens anyway (BR) |
| Application home page | `https://{{DOMAIN}}/` |
| Application privacy policy link | `https://{{DOMAIN}}/privacy` |
| Application terms of service link | `https://{{DOMAIN}}/terms` |
| Authorized domains | `{{DOMAIN}}` (one top private domain; subdomains are covered, BR) |
| Developer contact information | your own monitored address. Google sends every review email there, and missing them "could result in the loss of access" (VR) |

### 2.4 Redirect URIs (Google Auth Platform → Clients → your Web client)

- **The rule.** "Add authorized domains before adding redirect/origin URIs" (BR), and every authorized domain must be
  verified by you (VR). Practitioners say the same: "Verify the callback URL's domain in your Google Cloud project"
  ([Nango](https://docs.nango.dev/integrations/google-security-review)). A `supabase.co` callback has been reported to fail
  branding review ([Google forum, Aug 2026](https://discuss.google.dev/t/oauth-branding-verification-stuck-name-mismatch-due-to-supabase-callback-domain-no-trust-safety-email-received/389007)).
- **Value to register (one URI):** `https://{{DOMAIN}}/connect/google`
  - It reaches `career-connect` (PR #191) through a Vercel rewrite on the Trainee project. There is no extra cost.
  - In the `vercel.json` that the `trainee` project reads, add:
    ```json
    {"rewrites":[{"source":"/connect/google","destination":"https://mrwngntwmnaqrqhupvlt.supabase.co/functions/v1/career-connect"}]}
    ```
    That file is the repo root's if Project Settings → Root Directory is empty, or `site/vercel.json` if it is `site`. The
    Vercel MCP did not show the root directory, so check it before you add the rewrite.
  - Then set `CAREER_CONNECT_URL=https://{{DOMAIN}}/connect/google` on `career-connect` and `agent-chat`. That is the value
    `linkBase` already reads (#191 `career_connectors.ts:91`), so the link, the form post and Google's callback all stay on
    `{{DOMAIN}}`.
- **Alternative, paid:** Supabase's custom domain add-on, for example `api.{{DOMAIN}}`, with the redirect at
  `https://api.{{DOMAIN}}/functions/v1/career-connect`.
- **Do not register** `.../functions/v1/gmail-oauth` for Trainee. Its career route has no caller, and #191 replaces it.
  Register exactly one redirect URI.
- **Authorized JavaScript origins:** none. The flow is server-side.

### 2.5 Scope justifications (Data Access → each scope → justification box)

Paste these as written.

**`https://www.googleapis.com/auth/gmail.readonly`:**

> Trainee is a career agent that applies to jobs for a person only after they approve the exact application. It uses
> gmail.readonly for two user-facing features, both visible in the chat and in the person's application tracker.
>
> (1) Emailed security codes. Application systems (Greenhouse, Lever, Ashby, Workday) email the applicant a one-time
> security code during submission. While an application the person approved is being submitted, Trainee searches the
> person's inbox for that system's own sending domain received in the last few minutes (users.messages.list with q=from:(...)
> after:...), reads the matching message (users.messages.get format=full), checks Gmail's own DKIM/DMARC result, extracts the
> code with that system's pattern, and types it into the same form. The code is held in memory only and never stored,
> logged or shown in chat.
>
> (2) Application tracking. Trainee reads the From, Subject and Date headers and Gmail's snippet of new messages
> (users.messages.get format=metadata) to recognise an employer's confirmation, rejection, interview invitation or reply,
> and updates that application's stage in the person's tracker. It stores only the result (kind, employer, role, a short
> evidence line and a hash of the message id), never the message.
>
> Narrower scopes do not work. gmail.metadata cannot read the message body, where the code is, and does not support the q
> search both features use. gmail.labels gives no messages. Gmail has no per-message picker, and add-on current-message
> scopes require the person to open each message inside Gmail, which cannot fetch a code while the submission is waiting or
> track replies. Trainee requests no write scope: it cannot send, modify or delete mail. Disconnecting revokes the token at
> Google and deletes everything Trainee derived from Gmail.

**`openid` and `email`** are non-sensitive and need no justification. If the form asks anyway, paste:

> Used only to show the person which Google address they connected.

### 2.6 Demo video script

**Requirements (VR).**

- Show the "end-to-end flow ... including the OAuth grant process".
- Show the same app name and branding.
- Show the complete consent screen with "the same exact scopes".
- Set the language to English (the bottom-left toggle of the consent screen).
- Show each scope's functionality in use.

**Recording settings.**

- Unlisted YouTube video, about 4 to 6 minutes.
- Screen recording at a readable zoom.
- Record against production, with a test Google account added as a test user while the app is in Testing.

| # | Time | On screen | Say (voice-over or captions) |
|---|---|---|---|
| 1 | 0:00 | `https://{{DOMAIN}}/`, then scroll to the footer and open Privacy | "This is Trainee, a career agent you text. Its privacy policy, with the Google Limited Use statement, is linked here." Pause on `#limited-use` and `#google` |
| 2 | 0:30 | Telegram with the Trainee bot. Type `connect gmail` | "The person asks to connect Gmail. Trainee answers with what it will read and a one-time link." |
| 3 | 0:50 | Tap the link in an external browser (not Telegram's in-app view, which Google blocks). The pre-consent page reads "Before you connect Gmail" | Read the three sections aloud. Point at "Trainee can't send, delete, label or change any email." |
| 4 | 1:20 | Tap Continue to Google. Show **the address bar with `client_id=` and `scope=openid email https://www.googleapis.com/auth/gmail.readonly`**. Pick the test account | "This is Google's consent screen for the client we submitted." |
| 5 | 1:40 | The consent screen. Set the language to English, scroll the whole permission list ("View your email messages and settings"), tap Allow | "These are exactly the scopes requested." |
| 6 | 2:00 | Back on the page: "Gmail connected: test@…". Back in Telegram: the same message | "Trainee shows which address was connected. That is openid and email." |
| 7 | 2:20 | **Feature 1, emailed code.** In Telegram, approve an application to a Greenhouse test posting that sends a security code (`yes`). Split screen: the test Gmail inbox receives "Security code for your application", and the form's code field fills itself | "During an application the person approved, Trainee reads only the code email from Greenhouse's own domain and types it in. The chat never shows the code." |
| 8 | 3:20 | The employer's confirmation page, then the Trainee receipt in Telegram | |
| 9 | 3:40 | **Feature 2, tracking.** Send the test inbox a confirmation email from the employer, for example "Thank you for applying to Acme". In Telegram, type `check my email now`. The reply says Acme's application moved to Submitted/received. Show the tracker | "Trainee read the sender, subject and preview, recognised the employer's confirmation, and updated the stage. It keeps only that result." |
| 10 | 4:30 | Type `disconnect gmail`. The reply: revoked at Google and data deleted. Open `myaccount.google.com/permissions` and show Trainee is gone | "Disconnecting revokes access at Google and deletes what Trainee kept." |

**Re-record** if anything on screen differs from the submission: the app name, the scopes, or the client ID.

### 2.7 CASA: tier, labs, cost, timeline

- **What it is.**
  - Restricted scopes need "an annual security assessment from a Google empanelled group of security assessors" (VR).
  - Apps are placed at assurance level AL1 or AL2 by user count, scopes and risk (SA).
  - Labs sell this as CASA Tier 2 (lab-validated scan plus a self-assessment questionnaire) or Tier 3 (lab-run testing).
    Google gives no tier list. A single restricted Gmail read scope is commonly Tier 2 ([Nango](https://docs.nango.dev/integrations/google-security-review)).
- **How it starts.** "The Google Trust and Safety team will contact you when it is time to initiate the security assessment
  process" (SA). Forward that email to the lab you chose (Nango).
- **Cost.** Google charges no fee; the price is set by the lab (FAQ). Lab prices:

  | Lab | Tier 2 | Source |
  |---|---|---|
  | TAC Security | $540 (two revalidations) or $720 (unlimited revalidations) | Nango, prices as of Aug 2025 |
  | NetSentries | about $700 | Nango, prices as of Aug 2025 |
  | NetSentries | $900–1,500 | Switch Labs (undated, page © 2026) |
  | Leviathan | $800–1,200 | Switch Labs |
  | Prescient | $1,000+ | Switch Labs |
  | Prescient | $3,000+ | Nango |
  | Tier 3, for reference | TAC $4,500; others $5,000–8,000+ | [Switch Labs](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option) |

  **Recommendation:** TAC Tier 2 at $720, for unlimited revalidations. Get a current quote, because these prices are a year
  old. The FAQ summary fetched today also says Tier 2 "can be done free through a CASA authorized assessor". Ask TAC whether
  that applies before paying.
- **Timeline.**
  - Google's own estimates: brand 2–3 business days, sensitive 10 business days, **restricted about 6 weeks**, "not
    guaranteed" (FAQ).
  - Practitioners: 5–20 days from Google's CASA request to full verification. Budget 10–20 days with no prior audit
    (Nango). Letter processing takes up to a week.
- **What the lab checks, and what Trainee has.**
  - A static scan (SAST, for example the free Fluid Attacks CLI, Nango). Run it on this repo before you engage the lab, and
    fix high and medium findings.
  - About 50 ASVS-based questions. Trainee's answers:
    - **Tokens:** Supabase Vault, server-only, never sent to the client or the model (`gmail-oauth/index.ts`).
    - **Row-level security:** every mail table (`20261020100000_career_mail_tracking.sql`).
    - **No message content in logs:** logs in the Gmail modules print HTTP statuses only.
    - **Deletion on request:** disconnect and `20261026200011`.
  - Known gap the lab may flag: tokens use Vault's one project key, not per-user KMS envelopes (connectors research §5).
    Answer it honestly. It is a later hardening, not a blocker for Tier 2.
- **Every year:** a complete reassessment "whether you have made any changes or not" (FAQ). Google emails about 90 days
  ahead. Put your own reminder at day 270.

**Honest total: about 30 to 50 days from today.**

| Days | What happens |
|---|---|
| 1–2 | Domain bought and verified |
| 1–7 | #191 merged and functions deployed (§4.3), video recorded |
| about day 7 | Submit |
| about day 7–28 | Google's first review, typically with 1 or 2 rounds of questions |
| about day 10–40 | CASA Tier 2 |
| up to 7 more | Letter processing |

Until approval: at most 100 users can ever connect (lifetime, per project), they see the "unverified app" screen, and their
refresh tokens expire after 7 days in Testing (FAQ; connectors research §3.1).

---

## 3. What the code does, checked line by line against the policy

Each claim in the privacy template (`docs/launch/legal-pages/privacy.template.html`), the built `/google` page and the notice in `_shared/google_scopes.ts`, mapped to what makes it
true. "Fixed here" means this PR made it true.

| Claim | Made true by |
|---|---|
| Only openid, email, gmail.readonly are requested | **Fixed here:** `gmail-oauth/career.ts` `requestScopesFor`, `index.ts` start route (it requested Calendar and send before). PR #191's `mintLink` still asks for send by default; see §4.4 |
| The connected address is shown | **Fixed here:** `openid email` are now requested. Google's userinfo endpoint, which `index.ts` calls, returns the address only with the `email` scope, and the old request had none. This was not run live: it would need the real client |
| Codes never stored, logged or shown | `career_email_code.ts` `EmailCode` (prints "[emailed code]"), `handleEmailCode` returns it only to the approved, leased drive |
| Only the system's own authenticated sender, within 15 minutes | `fromAts`, `authenticated`, `CODE_WINDOW_MS` |
| Tracking reads headers + snippet only, never the body | `career_mail_gmail.ts` `format=metadata&metadataHeaders=From,Subject,Date,Authentication-Results` |
| Keeps only result, employer, role, an evidence line, a hash, the date | `career_mail_events` columns. `evidence` is at most 300 characters with no 6+ digit runs (DB check) |
| Unclear mail may go to OpenAI, masked | `career_mail_model.ts` `mailModelPayload` and `redact`, only with `CAREER_MAIL_MODEL=on`. OpenAI API data is not used for training by default ([OpenAI](https://developers.openai.com/api/docs/guides/your-data)) |
| Tokens encrypted, server-only | Vault `oauth_google_career_<uid>`; RLS on `user_oauth_connections` (`20261012060000`) |
| "disconnect gmail" in chat disconnects | **Fixed here:** `agent-chat/handler-career.ts` FEATURE GV calls `_shared/google_disconnect.ts` `disconnectGoogle` for both Google grants. Before this, the router answered "Nothing is deleted by this message alone". Proven end to end on real Postgres (`flow-google-disconnect.test.ts`): each grant's refresh token is posted to Google's revoke endpoint, and rows, Vault tokens and mail rows are gone. On trunk's handler the same test is 0/3 |
| Disconnect revokes at Google, and says so only when Google confirms | **Fixed here:** `revokeAtGoogle`. Only a 200 counts as revoked; a 400 is "refused", not confirmed. It uses a 5-second timeout, 3 tries on a network failure, timeout, 429 or 5xx, then the access token if the refresh token is refused. The reply names myaccount.google.com/permissions whenever Google didn't confirm (GV/5, flow test 2) |
| Disconnect deletes tracked results, drafts, read time | **Fixed here:** migration `20261026200011_google_disconnect_erase.sql` (a trigger on the career Google row's delete). Before this, these rows outlived the disconnect |
| A partial failure is never reported as done | **Fixed here:** every delete's result is checked, then rows, tokens and mail rows are read back. Any failure gives `ok:false` and a reply saying what couldn't be done (GV/6, eight failure paths). `gmail-oauth`'s disconnect uses the same code and answers 500 |
| "forget everything" deletes mail rows | `20261021090000_career_mail_erase.sql` |
| Can't send, delete, label or change mail | Only gmail.readonly is granted |
| No human reads mail | **Operational:** no admin screen exposes these rows (repo grep). It holds only if you and anyone with the service key keep it |

**Required changes found, and their status:**

1. Calendar and unapproved send in the consent URL: **done** (gmail-oauth).
2. No revocation at Google: **done** (chat and gmail-oauth, one implementation; #191's own `disconnectGoogle` should call
   `_shared/google_disconnect.ts` when it merges).
3. Gmail-derived data kept after disconnect: **done** (migration plus SQL test).
4. Email address not requested (no `email` scope): **done**.
5. The pre-consent screen: **the words are done** (`consentNotice`, published at `/google`). The in-app screen is #191's
   link page (`career_connect_flow.ts` GET `?t=`), which must render those same lines; see §4.4.
6. The chat's "disconnect gmail": **done here** (FEATURE GV in `handler-career.ts`), for the google_career grant and the
   legacy one.
7. The legacy finance consent (`start`, read by `agent-exec` with `format=full`) was offered by the same function:
   **off** unless `UPMORE_LEGACY_GMAIL_CONNECT=on`.
8. The career grant used to land on the Upmore app (`APP_URL`): **done**. It now lands on its own page, and
   `GOOGLE_OAUTH_REDIRECT_URI` can move the callback to Trainee's domain.
9. Placeholders in published pages: **done**. The build refuses until the owner fills them, and nothing is under `site/`
   until then.

---

## 4. Blockers before you press Submit

1. **A domain Trainee owns (hard blocker).**
   - Buy `{{DOMAIN}}`.
   - Add it to the Vercel project `trainee`. This also lifts Vercel SSO for that domain.
   - Verify it in Search Console (§5 step 2).
   - Without it, the homepage, the policy and the redirect URI can't be on a verified domain.
2. **A separate Google Cloud project for Trainee.** The current client is the founder's shared one, "same one Ring uses"
   (`gmail-oauth/index.ts:5-6`), so Ring and Upmore would sit under Trainee's brand review. The 100-user cap is per project
   and lifetime. A new project starts at zero.
3. **The features must work in production for the video.**
   - Merge #191.
   - Deploy `career-connect` (`--no-verify-jwt`) and `career-email-code`. Neither is in go-live `DEPLOY_FNS`
     (`scripts/launch/trainee-go-live.sh:252`); #139 is the open PR for that.
   - Apply `20261026160000` and this PR's `20261026200011`.
   - Set `CAREER_MAIL_TRACKING=on` on `career-proactive` and `agent-chat`.
   - Each of these is your deploy and your yes.
4. **#191 must not ask for gmail.send yet.** Its `mintLink` adds `openid email` plus the need's scopes, and "connect gmail"
   asks for read and send (`career_connectors.ts:252`). Before #191 merges, filter its scopes through
   `requestableScopes(scopes, Deno.env).scopes` from `_shared/google_scopes.ts`: one line in `mintLink`. Also replace the
   body lines of its peek page with `consentNotice(p.scopes)` (reads, never, undo), so the in-app screen says exactly what
   `/google` says. If it asks for an unapproved scope after verification, Google shows the unverified warning again.
5. **Fill the owner inputs** (§5 step 0), and confirm the owner-confirm items in §2.2.
6. **`site/privacy.html` on main.** Production deploys from `main`, where `site/privacy.html` is the extension-only policy
   (`b09c3c57`). This PR adds no page under `site/`; the only file it adds there is the logo candidate `site/brand/trainee-logo-120.png`. The build writes the full policy to `site/privacy.html`, with the
   extension text kept as `#extension`, only once the inputs are filled. The Chrome Web Store listing can keep its
   `/privacy` link.

---

## 5. Your click path, with every value

**Step 0: your inputs, then the build (2 minutes, in the repo).**

1. In `docs/launch/legal-pages/owner-inputs.json`, replace each `null` with your real value: `LEGAL_NAME`,
   `SUPPORT_EMAIL` (one address you read) and `GOVERNING_STATE`.
2. Run `deno run -A scripts/launch/build-legal-pages.ts`.
   - It writes `site/privacy.html`, `site/terms.html` and `site/google.html`, and updates `site/index.html`: the legal
     links, the help pages and `supportEmail`.
   - It also takes the unfinished template text out of the homepage instead of filling it with a guess: the launch-timing
     and price FAQ answers, the Pricing help page, the "Our story" and "The team" sections, and the template note on the
     Security and SMS Terms help pages. It rewrites the Connections help page and the coffee-chat copy so they claim only
     read-only Gmail and what networking really does (drafts from the contacts you give it; no people database), removes the
     "Works across the tools you already use" logo strip, and replaces the tour and home conversations with the real flow
     (Trainee prepares, you approve the exact card, statuses only as the product sees them, no invented counts). Job
     applications to Trainee go to `SUPPORT_EMAIL`. Add any of these back when you have the real words.
   - `scripts/extension/package.sh --variant agent` refuses while the privacy policy says the extension "never submits an
     application for you"; change that sentence first if you ever distribute the agent build.
   - If any input is missing or malformed, it prints `REFUSED: owner inputs missing or invalid: …` and writes nothing. If any
     placeholder, `[Bracketed instruction]` or template note is still in what it would write, it prints
     `REFUSED: placeholders left after filling: …`, naming each one, and writes nothing.
3. Review the diff, then commit.

**Step 1: the domain on Vercel.** Vercel → project `trainee` → Settings → Domains → Add `{{DOMAIN}}`. Use the A/CNAME records
Vercel shows at your registrar. Then deploy `main` with these pages.

**Step 2: verify the domain in Search Console.**

1. Go to https://search.google.com/search-console and sign in **with the Google account that owns or edits the new Cloud
   project**.
2. Add property → **Domain** → `{{DOMAIN}}` → Continue.
3. Copy the TXT value, `google-site-verification=…`.
4. At your registrar's DNS (or Vercel → Domains → `{{DOMAIN}}` → DNS Records, if Vercel is the nameserver), add:
   Type `TXT`, Name `@` (or blank), Value: the copied string, TTL default.
5. Back in Search Console, click **Verify**. DNS can take minutes to hours; retry.

**Step 3: the Cloud project.** https://console.cloud.google.com → project picker → New project → Name `Trainee` → Create.
Then go to APIs & Services → Library → **Gmail API** → Enable.

**Step 4: Google Auth Platform** (APIs & Services → OAuth consent screen opens it).

1. **Overview** → Get started. Then App information: App name `Trainee`, User support email `{{SUPPORT_EMAIL}}`. Audience:
   **External**. Contact information: your address. Agree → Create.
2. **Branding** (values from §2.3):
   - Logo: upload `site/brand/trainee-logo-120.png`.
   - Home page: `https://{{DOMAIN}}/`.
   - Privacy policy: `https://{{DOMAIN}}/privacy`.
   - Terms: `https://{{DOMAIN}}/terms`.
   - Authorized domains → Add domain → `{{DOMAIN}}`.
   - Developer contact: your address.
   - Save.
3. **Clients** → Create client:
   - Application type **Web application**.
   - Name `Trainee web`.
   - Authorized redirect URIs: `https://{{DOMAIN}}/connect/google`.
   - Create. Copy the client ID and secret into Supabase secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
     yourself. The secret never goes through chat.
4. **Data Access** → Add or remove scopes → tick `openid`, `.../auth/userinfo.email` (shown for `email`) and
   `https://www.googleapis.com/auth/gmail.readonly`. Nothing else. Update, then Save. Paste the §2.5 justification in the
   restricted-scopes box.
5. **Audience** → Test users → add your test Google account. Record the video now (§2.6), upload it unlisted, and copy the
   link.
6. **Audience** → Publishing status → **Publish app** → Confirm. It moves to "In production, needs verification".
7. **Verification Center** → Prepare for verification:
   - Confirm the branding and the scopes.
   - Paste the video link and the justification.
   - Answer "how will the scopes be used": the §2.5 text.
   - Submit.
   - Then **Verify Branding** if it is shown separately. Click **Publish branding** within 7 days of it passing (BR).

**Step 5: CASA.**

1. Before Google writes, ask TAC Security for a Tier 2 quote.
2. Run a SAST scan, for example Fluid Attacks' free CLI, on this repo. Fix any high or medium findings.
3. When Google's Trust and Safety email arrives, forward it to the lab and complete its questionnaire (§2.7 answers).
4. The lab sends the Letter of Validation to Google.
5. Watch the developer-contact inbox and answer within a few days each time.

**Step 6: after approval (later).** Ship gmail.send as its own submission:

1. Add the scope in Data Access, with its own video of an approved send.
2. After approval, set `GOOGLE_APPROVED_EXTRA_SCOPES=https://www.googleapis.com/auth/gmail.send`.
3. Turn on `CAREER_EMAIL_SEND` or `CAREER_OUTREACH_SEND`.

---

## 6. Proof in this PR

- `tests/architect/google-verification.test.ts` (13 tests, gate (architect)):
  - the scope filter and its lockstep copy;
  - revoke at Google: only 200 revokes; a 400 is refused; it uses a timeout signal, a call that hangs is cut and retried,
    5xx/429/network are retried 3 times with backoff, a 401 is not retried, and the access token is the fallback;
  - disconnect: success, Google unreachable, nothing connected, and eight failure paths, each `ok:false` with a plain
    reply;
  - the asks that disconnect and the ones that don't;
  - the legacy consent off, the career landing, and the redirect URI;
  - the build refusing with today's null inputs (the real command exits 1 and writes nothing);
  - no placeholder anywhere under `site/`;
  - pages built from sample inputs carrying Limited Use, the true scope list, the disconnect promise, the homepage links,
    and `/google` word for word.
- `tests/architect/flow-google-disconnect.test.ts` (3 tests, real `handleChat` on real Postgres, fake Google):
  - "disconnect gmail" posts `token=rt-c-…` and `token=rt-l-…` to Google;
  - the person's rows, Vault tokens and mail rows go from 2/2/3 to 0/0/0, while another person's stay 2/2/3;
  - Google down: 12 tries (3 per token, 2 tokens per grant, 2 grants), still deleted, and the reply says it wasn't
    confirmed;
  - nothing connected: no request to Google.
  - Fail-first: on trunk's handler, 0/3 ("Nothing is deleted by this message alone", no revoke request).
- Mutations, each red:
  - 400 counted as revoked, timeout removed, retries removed (GV/5);
  - each delete check removed, each read-back removed, the reply claiming a confirmation (GV/6);
  - the legacy gate removed, from the helper (GV/10) or the handler (GV/4);
  - the build ignoring missing inputs (GV/11).
- `tests/db/google_disconnect_erase.test.sql` (8 checks, database job):
  - a disconnect deletes events, drafts and cursor;
  - a reconnect (upsert) keeps them;
  - the legacy grant's delete keeps them;
  - nobody else's rows change;
  - account deletion still clears them;
  - the function is not callable by anyone signed in or anonymous.
  - Mutation: with the trigger's condition broken, check 3 fails ("FAIL disconnecting Google deletes the status events").
