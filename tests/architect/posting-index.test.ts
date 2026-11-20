// Posting index tests (fixtures only: the sandbox has no route to the ATS hosts; shapes are hand-written, not recorded).
import { applyVerdicts, contentSig, crawlBoards, extractDeadline, extractRequirements, levelOf, memoryIndexStore, verifyPosting, verifyQueue, verifyRequest } from "../../supabase/functions/_shared/posting_index.ts";
import type { Board, FeedPosting, FeedRead } from "../../supabase/functions/_shared/career_ingest.ts";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const NOW = Date.parse("2026-10-28T12:00:00Z");

Deno.test("deadline: stated dates only, never guessed", () => {
  assert(extractDeadline("Apply by March 15, 2027 to be considered.", NOW) === "2027-03-15");
  assert(extractDeadline("Application deadline: 2027-01-31", NOW) === "2027-01-31");
  assert(extractDeadline("Applications close on 15 November 2026.", NOW) === "2026-11-15");
  assert(extractDeadline("Deadline to apply: 12/01/2026", NOW) === "2026-12-01");
  assert(extractDeadline("apply before Jan 5", NOW) === "2027-01-05"); // next occurrence
  assert(extractDeadline("We hire on a rolling basis. Founded 2019-03-04.", NOW) === null);
  assert(extractDeadline("Apply by Feb 30, 2027", NOW) === null);
  assert(extractDeadline("", NOW) === null);
});
Deno.test("requirements and level", () => {
  const r = extractRequirements("About us: we build. Requirements: 3+ years of Go. Experience with Postgres and queues. Nice to have: Rust. Benefits: lunch.");
  assert(r && r.includes("3+ years of Go") && !r.includes("Rust") && !r.includes("lunch"), String(r));
  assert(extractRequirements("We build things. Come join.") === null);
  assert(levelOf("Software Engineering Intern, Summer 2027") === "internship");
  assert(levelOf("Engineer", "senior") === "senior" && levelOf("Engineer", null) === null);
});
const post = (i: number, over: Partial<FeedPosting> = {}): FeedPosting => ({ job_id: `greenhouse:acme:${i}`, company: "Acme", title: `Role ${i}`, url: `https://job-boards.greenhouse.io/acme/jobs/${i}`, ats_id: String(i), description: "Requirements: five years of anything useful here. Apply by March 1, 2027.", location: "Remote", ...over });
const BOARD: Board = { company: "Acme", provider: "greenhouse", board: "acme" };
Deno.test("crawl: new, unchanged, changed, closed, reopened; partial/failed/304 close nothing", async () => {
  const store = memoryIndexStore();
  let feed: FeedRead | Error = { postings: [post(1), post(2), post(3)], complete: true };
  const fetchFeed = async () => { if (feed instanceof Error) throw feed; return feed; };
  let s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: NOW });
  assert(s.new === 3 && store.open().length === 3);
  const p1 = store.rows.get("greenhouse:acme:1")!;
  assert(p1.ats_type === "greenhouse" && p1.deadline === "2027-03-01" && p1.requirements?.startsWith("five years") && p1.last_verified_at.startsWith("2026-10-28"));
  const T2 = NOW + 3600e3;
  feed = { postings: [post(1), post(2, { title: "Role 2b" })], complete: true };
  s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: T2 });
  assert(s.unchanged === 1 && s.changed === 1 && s.closed === 1 && store.rows.get("greenhouse:acme:3")!.closed_at && store.rows.get("greenhouse:acme:3")!.closed_reason === "gone_from_board");
  assert(store.rows.get("greenhouse:acme:1")!.last_verified_at === new Date(T2).toISOString());
  assert(store.rows.get("greenhouse:acme:1")!.first_seen_at === new Date(NOW).toISOString());
  feed = { postings: [post(1)], complete: false }; // partial: closes nothing
  s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: T2 + 1 });
  assert(s.boards_partial === 1 && s.closed === 0 && !store.rows.get("greenhouse:acme:2")!.closed_at);
  feed = new Error("HTTP 503");
  s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: T2 + 2 });
  assert(s.boards_failed === 1 && store.open().length === 2);
  feed = { postings: [], complete: false, not_modified: true };
  const T3 = T2 + 7200e3;
  s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: T3 });
  assert(s.boards_not_modified === 1 && s.verified === 2 && store.rows.get("greenhouse:acme:2")!.last_verified_at === new Date(T3).toISOString());
  feed = { postings: [post(1), post(2, { title: "Role 2b" }), post(3)], complete: true };
  s = await crawlBoards({ boards: [BOARD], fetchFeed, store, now: T3 + 1 });
  assert(s.reopened === 1 && !store.rows.get("greenhouse:acme:3")!.closed_at && store.rows.get("greenhouse:acme:3")!.first_seen_at === new Date(NOW).toISOString());
  assert(contentSig(post(1)) !== contentSig(post(1, { title: "x" })));
});
const res = (status: number, body = "", url = "") => { const r = new Response(body, { status }); Object.defineProperty(r, "url", { value: url }); return r; };
Deno.test("verify: only explicit gone is closed; uncertainty closes nothing", async () => {
  const gh = { provider: "greenhouse", board: "acme", ats_id: "7", url: "https://job-boards.greenhouse.io/acme/jobs/7", title: "Backend Engineer" };
  assert(verifyRequest(gh).url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs/7");
  assert((await verifyPosting(gh, { fetchFn: async () => res(404) })).verdict === "closed");
  assert((await verifyPosting(gh, { fetchFn: async () => res(200, "{}") })).verdict === "live");
  assert((await verifyPosting(gh, { fetchFn: async () => res(429) })).verdict === "unknown");
  assert((await verifyPosting(gh, { fetchFn: async () => { throw new Error("boom"); } })).verdict === "unknown");
  const ab = { provider: "ashby", board: "x", ats_id: "u", url: "https://jobs.ashbyhq.com/x/u", title: "Designer" };
  assert(verifyRequest(ab).url === ab.url);
  assert((await verifyPosting(ab, { fetchFn: async () => res(200, "<div id=root></div>") })).verdict === "unknown");
  assert((await verifyPosting(ab, { fetchFn: async () => res(200, "<h1>Designer</h1>") })).verdict === "live");
  assert((await verifyPosting(ab, { fetchFn: async () => res(200, "Sorry, this job is no longer available") })).verdict === "closed");
  assert((await verifyPosting(ab, { fetchFn: async () => res(200, "x", "https://boards.greenhouse.io/x?error=true") })).verdict === "closed");
  // queue + apply
  const store = memoryIndexStore();
  await crawlBoards({ boards: [BOARD], fetchFeed: async () => ({ postings: [post(1), post(2)], complete: true }), store, now: NOW });
  const q = verifyQueue(store.open(), NOW + 86400e3, 3600e3, 10);
  assert(q.length === 2);
  const r = await applyVerdicts(store, [{ p: q[0], v: { verdict: "closed", via: "ats_api", reason: "HTTP 404" } }, { p: q[1], v: { verdict: "unknown", via: "http" } }], NOW + 86400e3);
  assert(r.closed === 1 && r.unknown === 1 && store.open().length === 1);
});
