# People discovery at scale (D-MN-3 as replaced), 2026-10-27

The owner's decision at 21:32 CDT: "don't use Hunter or Apollo ... so we can do it with anyone". No paid people/email
provider is used. Trainee finds people and professional email addresses for any company the way a research agent does,
and puts them in the same `career_people` store as the person's own sources (LinkedIn export, Gmail, pages they send:
`career_people.ts`). Earlier work in this branch had Hunter.io and Apollo adapters. They were deleted before the PR,
so no code for them is merged and nothing calls them.

- Code: `supabase/functions/_shared/career_people_provider.ts`
- Schema: `supabase/migrations/20261027210000_career_people_provider.sql`
- Tests:
  - `tests/architect/people-provider-unit.test.ts`: search, pages and DoH faked
  - `tests/architect/flow-people-provider.test.ts`: real Postgres
  - `tests/db/career_people_provider_scale.py`: 1M people rows, 55,000 discoveries, 20 concurrent workers; run from `tests/db/run.sh`

## How a person and an address are found

1. **Search.** Trainee calls OpenAI's `web_search` tool through the Responses API, with the gateway's OpenAI config
   (`modelConfig`, OpenAI only). The search recipe for a company:
   - the role asked for, or "team"
   - "team page"
   - "engineering blog author"
   - "campus recruiting recruiter"
   - "conference speaker"
   - "press contact"

   Only the result URLs are used: `web_search_call.action.sources[].url` and the message's `url_citation` annotations.
   What the model writes is never taken as a fact. A name that appears only in the model's text is never stored, and the
   flow test checks this.
2. **Read.** Every result page is read with N1's `readPage` (`career_people_page.ts`, imported and not forked). The reader:
   - fetches HTTPS only, and only public addresses, checked on every redirect
   - honors robots.txt
   - stops at 2 MB or 8 s
   - takes only schema.org `Person` entries and named mailto links

   LinkedIn, Indeed and Handshake are never fetched. The search is told to leave them out (`blocked_domains`). If one
   comes back anyway, it is kept as text only.
3. **A person** exists only when a page names them and establishes their employer. That means the person's own
   `worksFor` is the company, or (when they have none) the page is on the company's domain or its Organization is the
   company. The person keeps that page's URL as `source_url`, and a database check refuses a discovered row without one.
   A role inbox (careers@, info@, ...) is never a person's address. A field that reads as an instruction is dropped, and
   a name that does drops the person.
4. **Addresses**, in order of strength. Each one is labeled on the candidate line and on the row:
   - **published**: the page that names them publishes it.
   - **known**: the person's own Gmail or export already has it. That row is theirs, so the discovered one is not stored
     again. A discovered published address for a contact who had none is linked to their own row (`same_as`).
   - **inferred**: from the domain's best format, learned from at least 2 distinct addresses at that exact domain, with
     the evidence count and a confidence. It is used only for a plain-ASCII name, so there is no transliteration guess.
     It is sent only after the person approves that exact address (D-MN-2; the outreach card shows the label).
   - The domain's MX is checked over DNS-over-HTTPS (`dohMx`). There is no SMTP or RCPT probing, ever.
   - `sendable` is true only when there is an address, the domain has MX, and the address never bounced. A database
     check holds this.
5. **Learning, shared**: `career_email_formats` stores, per domain, formats only, never an address, name or contact.
   Evidence is one vote per address, stored as a sha256 (`career_email_format_evidence`). The evidence comes from:
   - published addresses at the domain
   - the person's own addresses at that company, used as format evidence only

   `career_email_feedback(email, name, 'bounce'|'reply')` moves the format's confidence:
   - **bounce**: the address goes on `career_email_bad` (as a hash), every stored copy becomes unsendable and `bounced`,
     it is never inferred or sent again, and the format loses confidence.
   - **reply**: the format gains.

## Scale and no limits

- **Queue**: `career_provider_jobs` holds one active job per (company, roles), however many people asked
  (`career_provider_waiters`).
  - Jobs are claimed with `FOR UPDATE SKIP LOCKED` leases (`career_provider_claim`) by any number of workers.
  - Expired leases are reclaimed (`career_provider_reclaim`).
  - Only the lease holder can complete a job (exactly once).
  - Fairness: each person's discoveries get rising virtual ranks, starting at the queue's lowest.
- **Shared cache**: one discovery per (company, roles) for everyone inside `CAREER_PEOPLE_CACHE_DAYS` (default 30).
  - The shared tables hold no user id.
  - Each person gets their own copy, deduped against what they have (`career_provider_deliver`, one set-based statement).
- **No volume limit of Trainee's own** (owner, 2026-10-27 19:55). The only brake is the search service refusing:
  - OpenAI 429 is a rate limit, with its `retry-after`. 429 `insufficient_quota` is out of credit.
  - A refusal blocks discovery for every instance (`career_provider_state`). The job waits without spending an attempt.
  - The reply says plainly what happened and when it resumes.
- **Spend view**: `select * from career_provider_spend(now() - interval '30 days')` (service role). It shows, per day:
  - discoveries
  - calls (searches, pages read, MX)
  - results
  - model cost: the gateway's price for the tokens. The web_search tool's own per-call fee is not in `PRICES`, so read
    it on the OpenAI invoice.
  - cache hits
  - refusals
- **Erase**:
  - "forget my contacts" includes discovered rows (the forget-all sources in `career_people.ts`).
  - "forget everything" deletes discovered rows, waits and the ledger's user id (`career_provider_on_erase`).
  - `career_provider_forget(user)` deletes the discovered rows alone.
  - Shared formats stay; there is no person in them.

## Interfaces

```ts
interface PeopleProvider { name: "web"; supportsSchool: false; findPeople(q: FindQuery): Promise<FindResult> }
interface FindQuery { company?: string | null; domain?: string | null; titles?: string[]; seniority?: string[]; location?: string | null }
type FindResult = { status: "ok"; people: ProviderPerson[]; company; domain: string | null; mx: "pass" | "fail" | "not_run"; http_calls; cost_usd: number | null; text_only: string[] }
  | { status: "rate_limited"; retry_after_s; http_calls; detail } | { status: "out_of_credits"; http_calls; detail }
  | { status: "not_wired"; reason; http_calls } | { status: "error"; detail; http_calls };
interface ProviderPerson { provider: "web"; provider_id; name; email: string | null /* published only */; company; company_key; position; source_ref; source_url: string; profile_text: string | null }

providerConfig(env)                       // CAREER_PEOPLE_SEARCH=on + the gateway's OpenAI key; CAREER_PEOPLE_SEARCH_MODEL (default gpt-4.1-mini)
makeProvider(config, fetch, { resolve?, mx?, search? }): PeopleProvider | null   // null: NOT_WIRED, no call
notWiredReply(config): string             // the plain sentence
openAiWebSearch({ fetch, apiKey, model }): SearchFn;  searchRecipe(company, titles): string[]
webProvider({ search, fetch, resolve?, mx?, read? }): PeopleProvider

parseTargetAsk(message): TargetAsk | null
  // "people at every company I applied to", "engineering managers at every company I've applied to",
  // "engineering managers at Stripe", "recruiters or talent partners at Ramp", "alumni of DePaul at Stripe"
findTargets(userId, ask, { store, config, provider, now }): Promise<TargetsResult>
  // candidates: { id, name, title, company, email, address: "published"|"known"|"inferred"|null, evidence, sendable, source, source_url, reason }
  // reason e.g. "Engineering Manager at Stripe; matches "engineering manager"; named on https://stripe.com/team (read 2026-10-27);
  //   email inferred from stripe.com's format (2 addresses seen there), sent only if you approve it."
runLookups({ store, provider, batch, leaseSeconds, userId? })   // one worker pass
supabaseProviderStore(admin)              // the RPCs; feedback(email, name, "bounce"|"reply") for the send lane
```

"People at every company I applied to" reads the firms on `career_apply_jobs` (not failed or not submitted) and the
account tracker (`career:account` → `memory.tracker.rows[].company`). For alumni, public pages rarely say where someone
studied, so alumni come from the person's own contacts. The reply says so.

## Owner steps

1. Approve model spend for discovery. Each company costs 6 searches plus page reads, cached for everyone for 30 days.
2. Set the function secret `CAREER_PEOPLE_SEARCH=on`. The key is the existing `OPENAI_API_KEY`, and no new key is
   needed. This is optional:
   - `CAREER_PEOPLE_SEARCH_MODEL`: a model that supports Responses `web_search`. The default is `gpt-4.1-mini`, which
     OpenAI's guide lists for it.
   - `CAREER_PEOPLE_CACHE_DAYS`
3. Apply the migration with go-live (it is in `MIGRATIONS` with its `MIGRATION_MARK`).

Until step 2, nothing is searched. The reply says that searching the web for new people isn't switched on yet, answers
from the person's own contacts, and never makes up a name or an address.

## Sources read (2026-10-27)

- OpenAI web search guide, https://developers.openai.com/api/docs/guides/tools-web-search:
  - `POST /v1/responses` with `tools: [{ type: "web_search", filters: { allowed_domains | blocked_domains } }]`
  - `include: ["web_search_call.action.sources"]` and `tool_choice: "required"`
  - `url_citation` annotations `{url, title, start_index, end_index}`
  - models listed: `gpt-4.1` and `gpt-4.1-mini` (Responses), `gpt-5-search-api` (Chat Completions)
  - a per-call tool fee is on the pricing page
- MX over DNS-over-HTTPS: Cloudflare's JSON resolver, through the existing `dohMx` (`career_contacts.ts`).

## Requests (not done here)

- **Chat lane**: wire `parseTargetAsk` and `findTargets` into the people turn (N1's `career_people.ts`). Also run
  `runLookups` from a scheduled drain (career-proactive), so other people's queued discoveries run between chats.
- **Send lane**: call `store.feedback(email, name, "bounce" | "reply")` when Gmail reports a bounce or a reply, and show
  the address label (published, known or inferred) on the approval card.
- **N1**: `kindOf` in `career_people.ts` maps a discovered row to `own_export`. It should carry its own source kind (a
  public page, with its `source_url`) for the certifier's recipientSourced when drafting starts from these candidates.
- **Gateway**: the Responses-API search call lives in this module, using `modelConfig` and `costMicros`, because
  `model_gateway.ts` speaks Chat Completions only. Moving it into the gateway (with `reserveModelCall` budget rows) is
  the gateway owner's call.
