# Discovery default deny: engine interface for review (Muse), 2026-10-24

Candidate branch `arch/backend-g4-dryrun-deny`, not merged. It closes the gap in `DRY-RUN-NETWORK-2026-10-24.md`: a dry
run let the page's own same-origin GETs carry what the engine typed to the employer, before any approval. G4's
`prepareAhead` runs the same dry run before the person has even asked.

The outcome required: a dry run must not send anything of the person's to an employer, or anyone else, before their
approval, and reading the page must keep working.

## The rule

In `scripts/apply.ts`, **discovery** means a run without `--submit`: `approve-first.ts prepare()`, `prepare-batch`, and
`prepareAhead`. Approved runs (`--submit --approved`) are unchanged. There the person approved exactly what goes to this
employer.

The phase boundary is `populated`: the moment the engine puts the first of the person's values into the page (before the
first `fill`, the resume included).

- **Before the first value.** The page holds nothing of the person's: a fresh browser context, service workers blocked,
  and the URL is the posting's own. The routing is unchanged:
  - the posting's page loads;
  - its resources load;
  - same-origin reads are allowed (GET, and the employer's GraphQL read queries, `readOnly`);
  - every write is stopped, as before.
- **From the first value on: nothing leaves the page.** This covers every kind of request and every origin:
  - fetch, XHR, image, script, style, font and media;
  - beacon and ping;
  - main-frame navigations and redirects;
  - a worker's requests and a frame's requests;
  - a WebSocket message (`routeWebSocket`: the socket stays open, but no page-to-server message passes);
  - anything from a popup or a new tab (`context.route`: every request from any other page of the context is stopped).

  Nothing is inspected for what it carries. An encoded, shortened or transformed value is stopped the same as a plain
  one, and so is a request a timer scheduled before the first value.
- **Teardown.** Closing a context resumes the requests its routes still hold: a page timer's request reached the
  employer about 150 ms before a run ended. So discovery shuts the page down first, in this order: leave it for
  `about:blank`, go offline, and wait until every request already caught has been stopped (`unrouteAll({behavior:
  "wait"})`). Only then is the session closed.

### Evidence (new)

`evidence.discovery.stopped` is a list of `{ kind, method, origin, path }`, up to 200, de-duplicated. It never holds a
query, a fragment or a body. `kind` is the Playwright resource type, or `navigation`, `websocket` or `popup`.

### Outcomes (new reasons, `state: "not_submitted"`)

- `LOOKUP_NEEDS_APPROVAL: <field label>`: a field did not take its value during discovery, and a request was stopped
  while it was being filled. Its widget needs the employer's lookup of what was typed (a location or school search).
- `DISCOVERY_NAVIGATION_STOPPED`: the page tried to leave the form while it held the person's values. The navigation is
  stopped, and the browser then shows its own error page in place of the form, so the run ends. Answering the
  navigation with 204 was tried; Playwright then waits on a navigation that never commits, and the next fill times out.

Neither reason sends anything. A posting with either is not prepared before approval.

## Tradeoffs (stated, not hidden)

1. **Lookup fields.** A widget that completes only from the employer's suggestions (Ashby's place search, Greenhouse's
   location and school typeaheads) cannot be filled in discovery without sending what was typed. Those postings stop at
   `LOOKUP_NEEDS_APPROVAL`. The engine fills a plain text box with the value and stops its lookup request.
   - Usability is not permission: no exception is made for location or school.
   - The way out is the person's own approval for that posting: approve sending the typed lookup to that employer's own
     origin before the dry run. That needs a card or consent design (the owner's and the coordinator's), and it is
     **not built here**.
   - Cost, unmeasured here: the share of real postings whose required fields use a lookup widget. The captured forms
     (`tests/fixtures/forms-ci`) are served without their scripts, so they cannot show it. It needs a live-shaped
     fixture set, or a live census the owner approves.
2. **Multi-step forms that navigate between steps** while holding values stop at `DISCOVERY_NAVIGATION_STOPPED`. A
   single-page form, or a step change inside the page (no navigation), is not affected. Workday-style steps that save
   by POST were already stopped before this change.
3. **Captcha widgets after the first value** can no longer reach their provider during discovery. Before the first
   value they load as before. A widget that misbehaves offline may change what the page shows; the captured-forms suite
   pins today's outcomes.

## Unresolved limits (honest)

- **DNS.** A hostname built from a value (`<link rel=dns-prefetch href="//value.example">`, or any cross-origin request
  before interception) can leak through DNS resolution, which request routing does not see. Not mitigated or tested
  here. A launch flag (`--dns-prefetch-disable`) or a resolver rule would be needed, plus a test that can see lookups.
- **WebRTC** (STUN or ICE, data channels) is not routed by Playwright. Not mitigated or tested here.
- **A request already in flight at the first value.** A body streamed from before the first fill and still uploading
  after it is not covered. The HTTP request was admitted before any value existed.
- **Popups:** the guard is built, but this test proves it only when Chromium's popup blocker lets the window open. In
  one run the popup was blocked before reaching the network; in another it opened and was stopped.
- **The person's own browser** (extension path, D-017) is a different runtime with the person's own cookies. This
  change covers the engine (`scripts/apply.ts`) only, not the extension.

## Interface questions for review (Muse)

1. Is `populated` set before every way the engine puts a value into the page? It is set before each planned `fill`.
   Does any `observe`, `review` or `readback` command type, select or click a value before that?
2. Is `LOOKUP_NEEDS_APPROVAL` the right stop, or should discovery leave a lookup field unfilled and ask the person
   instead (the card shows it as theirs to fill)?
3. Which helper commands navigate the main frame after the first value on purpose (`review` advancing a step)? Those
   now end the run.
4. Should the same default deny apply to the extension's panel fill before approval? Out of this branch's scope.

## Tests

- `tests/architect/dry-run-deny.test.ts`, two runs against a local employer:
  - The page's scripts try 13 channels once the person's data is in it: GET autosave; short, reversed and base64 forms
    of the value; an image pixel; POST, PUT and beacon; location and school lookups; a polling timer started before
    any value; a same-origin frame; a Worker; a WebSocket opened before any value; another origin.
  - Nothing of the person's arrives anywhere, and each attempt is in the engine's own stopped list.
  - Reading still works: the page, its form definition, a GraphQL read query and the frame load, and the dry run
    reaches the card with all five values read back.
  - The second run: a navigation carrying the email, and a popup, are stopped, and the run ends
    `DISCOVERY_NAVIGATION_STOPPED`.
- **Fail-first** at f3cfab7f, before this change: the employer received the GET autosave, the transformed values, the
  pixel, the poll, the frame's and the Worker's requests, the location and school lookups and the WebSocket message,
  and the navigation reloaded the page with the email in its URL.
- `tests/architect/dry-run-network.test.ts` (the claim check) now asserts that the GET autosave is stopped.
