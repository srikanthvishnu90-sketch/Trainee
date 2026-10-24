# Discovery default deny: engine interface for review (Muse), 2026-10-24

Candidate branch `arch/backend-g4-dryrun-deny`, not merged. It closes the gap in `DRY-RUN-NETWORK-2026-10-24.md`: a dry
run let the page's own same-origin GETs carry what the engine typed to the employer, before any approval. G4's
`prepareAhead` runs the same dry run before the person has even asked.

The outcome required: a dry run must not send anything of the person's to an employer, or anyone else, before their
approval, and reading the page must keep working.

## The boundary (decision, coordinator review of fc7ac325)

**Chosen, and the engine's default: nothing of the person's goes into the page before their approval.**

- Discovery (every run without `--submit`) only reads the form. It opens the posting, reads the fields, the employer's
  own options and hidden fields, the destination and the verification, and plans every answer off the page.
- Nothing is typed, chosen, attached or clicked. The card is built from the plan.
- The approved run is the first to fill the page. It reads back every answer and re-checks the form, the destination
  and the payload before the click. Any difference stops it with nothing sent (`APPROVED_APPLICATION_CHANGED`,
  `READBACK_MISMATCH`, `PAYLOAD_CHANGED_BEFORE_CLICK`, or `needs_answers` for a question it had not seen).

This is sound by construction, not by measurement: the engine never issues a fill, type, select, attach or click
command in discovery. That does not depend on how any Chromium version treats a document. What a read-only visit still
gives the employer is said under "Before the first value" below: the visit, the address it came from, the browser's
headers, and the employer's own analytics.

**Not chosen: filling before approval under per-class leak control** (the rest of this note). It stays in the engine
only as `--discovery-fill`, which is refused for anything but the local test pages (`DISCOVERY_FILL_LOCAL_ONLY`), and
only so the tests below keep witnessing its guards. It cannot be assured to send nothing of the person's, and the
default for what cannot be assured is refusal. Shown here:
- the page's last timer requests after the engine let go of it (3 of 40 runs on 141, 1 of 15 on 156, before the
  crash shutdown);
- `fetchLater` flushed by a renderer crash (156);
- crash dumps on disk that hold the person's data (3 of 262);
- what the browser does outside CDP: DNS, WebRTC, its own sends.

### What each choice keeps and loses

| Capability | Read-only discovery (chosen) | Filled discovery (not offered for real employers) |
|---|---|---|
| Prepare before the person asks (G4) | **kept**: G4's flow, 8 steps, green with read-only prepares on 141 and 156; the approved run's hash matched the prepared one | kept |
| Card shows what the page took (readback) | **lost before approval.** The card shows each planned answer in the form's own words (a select's own label). The approved run reads every answer back before the click; a difference stops it unsent | kept |
| A field that does not keep its value, or reads back differently | found **after** the yes: not sent, and the person is told | found before the yes |
| A question that appears only once something is filled (conditional) | **lost.** It is not seen before approval; the approved run stops `needs_answers` with nothing sent (`discovery-read-only.test.ts`, 141 and 156) | seen, if the fill reveals it |
| A form with a step before its last page | **lost**: not prepared, `MULTI_STEP_NEEDS_APPROVAL` (`discovery-read-only.test.ts`) | in-page steps fillable; a navigation stops it |
| Location or school lookups | planned text only; the approved run types it and picks a suggestion; a pick that reads back differently stops it unsent. **Not measured on a lookup fixture** | stopped at `LOOKUP_NEEDS_APPROVAL` (about 7 of 17 captured forms) |
| The 17 captured forms (`career-apply-real-forms`) | all stop at `needs_answers` before any fill with the test's facts, so they cannot show a difference: 74 of 74 engine tests pass on 156 | same |

**Recommendation: read-only discovery**, as built here. It keeps prepare-ahead and costs:
- the readback-verified card;
- conditional questions;
- multi-step forms.

Each is lost safely: the approved run sends nothing when the page differs from what was approved. Recovering them
needs the person's approval scoped to a stage: "send these answers to this employer's own form, to see what it asks
next". That is a card and consent design for the owner and the coordinator, not built here.

### Muse's static review of fc7ac325, folded in

- **(a) The filled mode stops all egress after the first value, not only navigations.** That includes same-origin
  GraphQL reads. A form that loads a section or its options after the first answer then ends `FORM_DID_NOT_SETTLE`,
  or is observed only in part. The read-only default has the same loss in another form: a section or option list
  that appears only after an answer is never seen before approval. The approved run then finds the form changed and
  stops with nothing sent (`needs_answers` or `APPROVED_APPLICATION_CHANGED`). Either way, **forms that build
  themselves from the person's answers cannot be prepared before approval.**
- **(b) `LOOKUP_NEEDS_APPROVAL` rests on a coincidence.** It fires only when a fill does not persist *and* a request
  was stopped during it.
  - A lookup whose typed text persists, while the real value sits in a hidden companion (Lever's `location-input`
    with `selectedLocation`), passes the filled mode as prepared with the lookup unresolved.
  - An unrelated stop can mislabel a plain failure.

  The filled mode is now refused for real employers, so this detector decides nothing in the product.

  **The same pattern is open in the approved run:**
  - Its readback checks the visible text, not the hidden companion. So a Lever location could be sent typed but
    unselected.
  - Not changed here; this is pre-existing behaviour.
  - Proposed: treat a text field with a hidden lookup companion as a lookup, and require the companion set to the
    chosen option before the click (a test pair on the Lever `forms-ci` fixtures).
- **(c) Done.** The boundary's reasons are registered as by design in the cloud worker (`worker.ts` `BY_DESIGN`:
  `LOOKUP_NEEDS_APPROVAL`, `MULTI_STEP_NEEDS_APPROVAL`, `DISCOVERY_NAVIGATION_STOPPED`, `DISCOVERY_FILL_LOCAL_ONLY`).
  - `settle()` keeps the full reason with the field it names. It used to cut it at the colon; the class still
    decides the outcome.
  - The cloud prepare's refusal carries `stopped`, the engine's reason with its field, beside `PREPARATION_REFUSED`.
  - `prepareAhead` already records the engine's reason whole.
  - Test: `tests/architect/discovery-reasons.test.ts`, fail-first: 4 red before, 5 green after.

## The rule (filled discovery, `--discovery-fill`, local test pages only)

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
- **No unload handlers.** What a page sends while it is being unloaded passes the routes and the offline switch. Shown
  on Chrome 156: the employer received the page's pagehide beacon and keepalive fetch at teardown (coordinator, at
  1bd25593, locally and in the gate). On Chromium 141, a cross-site frame's did too. A page can also unload itself with no
  request the routes would see (`location = "about:blank"`; shown on 156). So in every frame, before any page script,
  discovery registers the first listener on the window for `beforeunload`, `pagehide`, `unload`, `visibilitychange`,
  `freeze` and `pageswap`. It is capturing and stops the event there (`stopImmediatePropagation`), so none of the page's
  own handlers runs, an `onpagehide` attribute's included. A page that needs these events does not get them in
  discovery.
- **No `fetchLater`.** The browser itself sends a deferred request when the page goes. It is removed from every frame,
  as `SharedWorker` is. Seen escaping once in a standalone experiment on 156: a plain page close, routes and offline in
  place.
- **The page shut where it is: scripts off, its renderers crashed, then closed.** In order:
  1. The engine turns script execution off in every frame of every page (CDP `Emulation.setScriptExecutionDisabled`;
     a cross-site frame has its own session).
  2. It waits until no stop is in progress (two quiet checks, at most one second).
  3. It crashes every frame's renderer (CDP `Page.crash`).
  4. It closes the pages. The routes and the offline switch are kept throughout.

  Why the crash: a document the engine lets go of any other way runs on out of its reach for a moment.
  - Closing the page in place, with scripts off, still leaked a timer's `GET /poll?v=…` unrouted after a stopped
    navigation: 3 of 40 runs on 141, 1 of 15 on 156 (d037a1a6).
  - Aborting the navigation into the browser's error page leaked the same way, about 1 run in 15 on 141. Timestamps:
    scripts were off and no request had been routed for about 170 ms; then, 10 ms after the abort, the poll and a
    frame's request arrived.

  What fits the timings, inferred and not read in Chromium's source: when DevTools leaves the document, its
  overrides go with it, and a task it already had queued runs. A crashed renderer runs nothing. The browser still
  sends a document's `fetchLater` when its renderer dies, which is why discovery removes it.

  This runs:
  - at teardown, instead of the old order. The old order left the page for `about:blank` first, which ran the unload
    handlers.
  - when the page tries to leave the form after the first value. The navigation is never let through. The run ends
    there anyway, and the engine's command in progress fails once the page closes.

- **Local fixtures only:** for a loopback posting the engine grants `local-network-access`. Every page the route serves
  is answered by the engine, so Chrome 156 does not count it as local, and its local network checks refused the
  fixture's own loopback socket (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). The socket class then went untested
  there. A real employer is never loopback; nothing changes for it.

### Evidence (new)

`evidence.discovery.stopped` is a list of `{ kind, method, origin, path }`, up to 200, de-duplicated. It never holds a
query, a fragment or a body. `kind` is the Playwright resource type, or `navigation`, `websocket` or `popup`.

### Outcomes (new reasons, `state: "not_submitted"`)

- `LOOKUP_NEEDS_APPROVAL: <field label>`: a field did not take its value during discovery, and a request was stopped
  while it was being filled. Its widget needs the employer's lookup of what was typed (a location or school search).
- `DISCOVERY_NAVIGATION_STOPPED`: the page tried to leave the form while it held the person's values. The navigation is
  never let through: the page is shut where it is (scripts off, renderers crashed, closed), so the run ends.
  - Aborting it was the first design. The browser then showed its own error page, and the form, unloading out of the
    engine's reach, sent a timer's request (see the rule above).
  - Answering it with 204 was also tried. Playwright then waits on a navigation that never commits, and the next fill
    times out.

Neither reason sends anything. A posting with either is not prepared before approval.

## Per class: what the employer's server received (the witness)

From `tests/architect/dry-run-deny-classes.test.ts`, every case sending the person's value after the first fill. Run
on two browsers: Chromium 141.0.7390.37 (Playwright's chromium-1194) and Chrome for Testing 156.0.8078.4 (chromium-1248,
the build Playwright 1.64.1 installs, and the one the coordinator and the gate run). Both as an unprivileged user, with
a fresh HOME and the engine's own state directory per run.

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
| pagehide, unload, visibilitychange senders, beacon and keepalive (teardown) | received | nothing | unload guard; scripts off at teardown (red only with both removed, G1+T2; the old about:blank teardown with no guard is red on 156) |
| Each frame's pagehide sender, same-origin and cross-site (own process) | received (cross-site on 141 and 156) | nothing | unload guard in every frame; scripts off per frame session |
| The page leaving for about:blank by itself, pagehide sender set | received on 156 | nothing (the run ends `DRIVER_ERROR`, not yet a named reason) | unload guard (G1 red on 156) |
| fetchLater registered after the first value | sent at a plain page close once (standalone, 156) | the page has no fetchLater | removed (T4 red: the test sees `typeof fetchLater`) |
| A timer firing while a stopped navigation unloads the form | (race: about 1 in 15 on 141 with the navigation aborted) | **still received in 1 of 48 runs on 141** (0 of 23 on 156) with the crash; 3 of 40 and 1 of 15 without it | not closed: filled discovery is local-only, and the default fills nothing |
| Form sent by GET; a link's ping | refused for another reason | nothing; `DISCOVERY_NAVIGATION_STOPPED` | navigation guard |
| Popup / new tab | (Chromium's popup blocker usually stops it) | nothing | `context.route`; proven only when the popup opens |

### Witness counts at this head (the employer's server, and another origin's, as the only witness)

8 runs on each browser of `dry-run-deny-classes`, `dry-run-deny` and `discovery-read-only` (9 tests a run). Each run
witnesses every class below. Chromium 141.0.7390.37 (chromium-1194); Chrome for Testing 156.0.8078.4 (chromium-1248).
Unprivileged user, fresh HOME, the engine's own state directory per run.

| Class | Mode | 141: runs with nothing of the person's received | 156 |
|---|---|---|---|
| The prepare puts nothing in the page; the approved run sends exactly the approved answers, once | read-only (default) | 8 of 8 | 8 of 8 |
| A conditional question: not seen before approval; the approved run sends nothing | read-only | 8 of 8 | 8 of 8 |
| A multi-step form: not prepared | read-only | 8 of 8 | 8 of 8 |
| The classes page read only: no input handler ran | read-only | 8 of 8 | 8 of 8 |
| Sockets, workers, frames, the late redirect, link hints, unload senders, fetchLater | filled | 8 of 8 | 8 of 8 |
| A form sent by GET, a link's ping | filled | 8 of 8 | 8 of 8 |
| The page leaving for about:blank by itself | filled | 8 of 8 | 8 of 8 |
| 13 channels at once (dry-run-deny 1) | filled | 8 of 8 | 8 of 8 |
| A navigation and a popup carrying the email (dry-run-deny 2) | filled | **7 of 8** (`GET /poll?v=Qzrina` once) | 8 of 8 |
| After the crash: the socket closed with no frame, no service worker fetched | filled | 8 of 8 | 8 of 8 |

### `Page.crash`: what it does (filled discovery only, local test pages)

The read-only default never crashes anything: it puts nothing of the person's in the page and closes it as any
session does. The crash is used only by `--discovery-fill`, where the page holds values. What it does, each with the
employer's server as the witness:

| Effect | What was seen |
|---|---|
| Requests in flight carrying a value | none can exist at the crash: every request after the first value was stopped by the routes while DevTools held the page (every classes and deny run; counts below) |
| `fetchLater`, a browser-owned deferred send | **flushed by the crash.** With its removal disabled, the employer received `GET /fetchlater-leak?v=Wyxlene` on 156 (1 run); on 141 it was not received (1 run). Removed from every frame in discovery; a page that obtains it in a realm before the init script runs is not covered |
| Beacons and keepalive fetches | while the page lives, stopped by the routes; at unload, the handlers are stopped by the guard, and a crashed renderer runs no unload |
| A service worker from before | none can exist: a fresh context with `serviceWorkers: "block"`; the employer never received `GET /sw.js` (counts below) |
| A socket opened before the first value | closed by the crash (the employer logs `WS-CLOSE /ws-before`), with no frame after the first value (counts below) |
| The evidence and readback | the dry run's evidence is written before teardown. After a stopped navigation it is written after the crash, from the engine's memory: the deny test reads its reason and stopped list. Nothing reads the page after the crash |
| **Crash dumps on disk** | Chromium's crash handler writes a minidump of each crashed renderer under the user's HOME (`.config/<browser>/Crash Reports/pending/`). **3 of 262 dumps from these local runs held a test person's value**: the URL of the page timer's request, `/poll?v=Qzrina`, in renderer memory. Whether they would be uploaded was not tested; they stay "pending". On its own, this rules the crash out for a real person's data |

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
- **The page's last requests after a stopped navigation: NOT closed, in filled discovery.** A page timer's request
  reached the employer unrouted, on the same test, under each teardown tried:

  | Teardown | Chromium 141 | Chrome 156 |
  |---|---|---|
  | Navigation aborted into the error page | about 3 of 45 runs | (not run) |
  | Scripts off, page closed in place (d037a1a6) | 3 of 40 | 1 of 15 |
  | Renderers crashed first (fc7ac325 and this head) | **1 of 48** | 0 of 23 |

  This is one of the reasons filled discovery is not offered for real employers. The read-only default puts no value in
  the page, so there is nothing for such a request to carry.
- **What this does not cover** (residual, by design of what is here):
  - A page script that ran before the init script, in a frame that was already open.
  - A native form submission the routes do not see as a request of the page.
  - A cross-process navigation the engine does not start.
  - Anything the browser sends outside CDP interception: DNS, WebRTC, its own traffic, and deferred or keepalive
    requests a document hands to the browser.

  DOM listeners and scripts-off hold only where they were installed and while DevTools holds the document.
- **The witness:** each test keeps the employer's server log open through the engine's exit and the context teardown,
  plus 0.8 to 2.5 s after, and asserts on everything it received. It does not stop observing when the run reports.
- **A document the engine does not unload itself.** A page that leaves for `about:blank` by itself runs no unload
  handler (the guard), but nothing else is done for it. It ends `DRIVER_ERROR`, not a named reason. A frame that
  navigates itself is stopped by the routes and shows an error page inside the form; whether its old document
  lingers out of reach the way the main frame's did is not tested.
- **The engine killed** (a timeout or SIGKILL before its `finally`): the browser shuts down on its own. The unload guard
  is in the page, so it still holds. Scripts-off and the in-place close do not happen. Not tested.
- **The wait for stops in progress** (at most one second) is not shown necessary by any test here. Its mutation stays
  green.
- **A page built to get around the guard** could create a frame before the init script runs in it and register its
  handlers there. Not tested; the threat model here is ordinary analytics and autosave, not a page attacking the
  engine.
- **Status:** with the read-only default, G4's dry run puts nothing of the person's into an employer's page. It stays a
  candidate until it is reviewed (Muse: the engine interface) and merged, and full CI at the exact head is owed with
  every push. This branch is a candidate, not
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
- `tests/architect/dry-run-deny-classes.test.ts`, review round 2 (the coordinator's repro at 1bd25593):
  - The fixture gained unload, visibilitychange and fetchLater senders, and each frame's pagehide sender. The
    cross-site frame moved to `localhost`, so it is a separate site in its own process. The fixture also gained a
    third run: the page leaving for `about:blank` by itself.
  - **Fail-first** at 1bd25593:
    - Chrome 156: the employer received the page's pagehide, unload and visibilitychange senders and the same-origin
      frame's; the other origin received the cross-site frame's.
    - Chromium 141: the cross-site frame's senders reached the other origin. The page's own were stopped, which is
      why this passed on 141 before.
    - About:blank run on 156, with the guard removed: received.
  - **Mutations on 156**, each alone; red unless noted:
    - G1 (no unload guard): red, the about:blank run.
    - T2 (no scripts-off): green, masked by the guard.
    - G1+T2: red.
    - G1 with the old about:blank teardown: red.
    - T4 (fetchLater kept): red, the page has fetchLater.
    - S1 (SharedWorker kept): red, `/shared-leak`.
    - L1 (no local-network grant): red, the socket from before the first value never opened.
    - W1+O1 (frame guard and offline off): red, `WS-FRAME`.
    - W2+O1 (connect guard and offline off): red, `WS-OPEN /ws-after`.
  - **Navigation race:**
    - With the navigation aborted into the error page (141), 3 runs in about 45 leaked a timer's request after the
      navigation was stopped.
    - With the page closed in place (d037a1a6), it still leaked: 3 of 40 runs on 141 and 1 of 15 on 156, each a
      `GET /poll?v=Qzrina` in the navigation test.
    - With every renderer crashed before the page is let go: 0 of 40 on 141 and 0 of 15 on 156 at first, then 1 of 8
      on 141 at this head: 1 of 48 in all on 141, 0 of 23 on 156. Not closed.
  - The full three-file set (classes, deny, network) was 5 of 5 green on each browser at d037a1a6, and green on both
    with the crash shutdown. The engine suites (career-apply-script, real-forms, engine, completion) passed 74 of 74 on
    156.
  - Exact-head CI at d037a1a6: the gate and the database jobs were green (run 40093472472).
