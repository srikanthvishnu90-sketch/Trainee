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
- **Offline from the first value.** Immediately before the first value goes in, the whole browser context goes
  offline (`setOffline(true)`). This also covers the hop the router does not see: the browser follows a redirect by
  itself, so the redirect of a read started before the first value bypassed the routes (shown: it reached the employer
  with the offline switch removed).
- **Sockets.** A socket opened after the first value is never connected (its address can carry the value). A socket
  opened before it stays open, but none of the page's frames after it pass.
- **No shared workers.** A shared worker's requests are seen by neither request routing nor the offline switch (shown:
  one reached the employer with both in place). Discovery therefore removes `SharedWorker` from every frame before any
  page script runs (`addInitScript`). A page that needs one does not work in discovery.
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

## Per class: what the employer's server received (the witness)

From `tests/architect/dry-run-deny-classes.test.ts`, every case sending the person's value after the first fill.

| Class | Old engine (8510e157) | Candidate | Guard that stops it (each shown by mutation) |
|---|---|---|---|
| Socket opened before, frame sent after | frame received | nothing | frame guard (W1+O1 red); also the offline switch |
| Socket opened after, value in its address | handshake and frame received | nothing | connect guard (W2+O1 red); also the offline switch |
| Dedicated web worker | received | nothing | routing (worker requests are routed) |
| Shared worker | received | nothing | `SharedWorker` removed (S1 red); neither routing nor offline stops it |
| Service worker | nothing (blocked by the context) | nothing | `serviceWorkers: "block"` |
| Same-origin frame | received | nothing | routing |
| Cross-origin frame | nothing (cross-origin was already stopped after the first fill) | nothing | routing |
| Redirect of a read started before the first value | (run refused for another reason) | nothing | offline switch (O1 red: the hop reached the employer) |
| prefetch link | received | nothing | routing |
| preconnect / dns-prefetch | nothing seen (no HTTP request; DNS not observable here) | nothing seen | not proven: DNS is not witnessed by this test |
| pagehide beacon and keepalive fetch (teardown) | received | nothing | routing, kept until the page is shut |
| Form sent by GET; a link's ping | refused for another reason | nothing; `DISCOVERY_NAVIGATION_STOPPED` | navigation guard |
| Popup / new tab | (Chromium's popup blocker usually stops it) | nothing | `context.route`; proven only when the popup opens |

**What the browser cannot be made to stop here:**

- DNS resolution of a hostname the page builds (prefetch, or the host of a stopped request): routing sees no DNS.
- WebRTC (ICE/STUN, data channels).
- A request body that was already streaming before the first value. Chromium does not stream uploads over HTTP/1.1,
  so this is not testable locally.
- Anything the browser itself sends outside the page (its own update checks and the like).

## Before the first value: what this rule does not cover

The rule starts at the first value the engine puts into the page. Before that, the page loads and reads normally, and
a page can learn things the engine never typed:

- that this posting was opened, when, and from which machine: the server's own IP on the G4 path, or the person's IP
  on their own computer;
- the browser's headers and fingerprint;
- what its own analytics record, keyed by the posting.

A field the employer filled in itself (from a link parameter or its own records) is the employer's data, not
something the engine sent. The context is fresh, with no cookies and no storage, so nothing of the person's from
earlier sessions is in the page. This is not an absolute privacy claim: the posting's own page and the employer's
analytics see a visit.

## Tradeoff measured on the captured forms (test environment only)

A static census of the 17 captured application forms (`tests/fixtures/forms-ci`, rendered from live pages). The captures
are served without their scripts, so no lookup runs in them, and `career-apply-real-forms` (18/18) cannot show these
stops. Which fields are lookups was read from each form's own markup and schema (`ashby-schemas.json`; Greenhouse
labels' required marker). The first pass is `python3 -I docs/architect/tools/lookup_census.py .`. Its raw
output needed by-hand correction, recorded here:
- a yes/no question about "free school meals" was flagged and is excluded;
- Ashby's and Lever's location fields were missed and were read from `ashby-schemas.json` and their `location-input`
  markup.

| ATS | Postings | Required location or school lookup (likely `LOOKUP_NEEDS_APPROVAL`) | Optional lookup | Navigate between steps |
|---|---|---|---|---|
| Greenhouse | 5 | 3: spacex (Location (City), School), wppmedia (Location (City)), anduril (School) | 1: eosfitness (School). anduril's "top location preference" unclassified (static list or lookup) | 0 |
| Ashby | 6 | 4: crusoe, harvey, openai, snowflake (`_systemfield_location`, place search) | 1: airwallex | 0 |
| Lever | 6 | 0: all 6 have an optional `location-input` text box; typed text persists, and the hidden `selectedLocation` is filled only by the lookup | 6 (text box) | 0 |

- **About 7 of 17 captured postings (41%)** would likely stop before approval under this rule. Up to 9 would, if the
  engine fills optional lookups for which the person has a fact.
- The workday fixtures are multi-step, but their steps save by POST, which was already stopped before this change.
- The gauntlet forms are synthetic and are driven by their own driver, not the engine.
- **None of this is confirmed live:** it needs live-shaped fixtures with the lookup scripts.
- A cheap improvement for review: leave an *optional* lookup field empty during discovery instead of stopping.

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
- **Status:** G4's real dry run stays unsafe to use until this is reviewed and merged. This branch is a candidate, not
  stand-alone readiness. Full CI at the exact head is owed with every push.
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
