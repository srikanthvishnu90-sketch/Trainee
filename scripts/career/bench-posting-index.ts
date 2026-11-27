// Benchmark of the posting index on SYNTHETIC data (no network): 150,000 postings over 3,000 boards, ~3.3 KB descriptions
// (the WO-017 measured mean). Pass 1 = first read (all new); pass 2 = steady state: 70% of boards answer 304, the rest return
// the same list with ~5% churn (new/changed/closed). Reports wall time, postings/s, heap and the stored size.
//   deno run -A scripts/career/bench-posting-index.ts [postings=150000]
import { crawlBoards, memoryIndexStore } from "../../supabase/functions/_shared/posting_index.ts";
import type { Board, FeedPosting, FeedRead } from "../../supabase/functions/_shared/career_ingest.ts";
const N = Number(Deno.args[0]) || 150000, PER = 50, B = Math.ceil(N / PER);
const boards: Board[] = Array.from({ length: B }, (_, i) => ({ company: `Co${i}`, provider: ["greenhouse", "lever", "ashby", "workable"][i % 4], board: `co${i}` }));
const para = "We are looking for an engineer. Requirements: 3+ years building services, strong SQL, clear writing. Nice to have: Rust. Apply by March 1, 2027. ";
const desc = (i: number) => (para + `Lorem ipsum ${i} `.repeat(4)).repeat(22).slice(0, 3300);
const list = (bi: number, gen: number): FeedPosting[] => Array.from({ length: PER }, (_, k) => {
  const id = bi * PER + k, churn = gen > 0 && id % 20 === 7; // 5% changed in pass 2
  if (gen > 0 && id % 20 === 0) return null as any; // 5% closed
  return { job_id: `${boards[bi].provider}:${boards[bi].board}:${id}`, company: boards[bi].company, title: `Engineer ${id}${churn ? " II" : ""}`, url: `https://example.test/${id}`, ats_id: String(id), location: id % 3 ? "Remote" : "Austin, TX", description: desc(id), pay: null };
}).filter(Boolean);
let gen = 0;
const fetchFeed = async (b: Board): Promise<FeedRead> => {
  const bi = Number(b.board.slice(2));
  if (gen > 0 && bi % 10 < 7) return { postings: [], complete: false, not_modified: true };
  return { postings: list(bi, gen), complete: true };
};
const store = memoryIndexStore();
const mb = () => Math.round(((Deno.memoryUsage().heapUsed) / 1048576));
let t = performance.now();
const s1 = await crawlBoards({ boards, fetchFeed, store, now: Date.now(), concurrency: 8 });
const d1 = performance.now() - t;
console.log(`PASS1 first read: ${s1.new} new from ${B} boards in ${(d1 / 1000).toFixed(2)} s = ${Math.round(s1.new / (d1 / 1000))} postings/s; heap ${mb()} MB`);
gen = 1; t = performance.now();
const s2 = await crawlBoards({ boards, fetchFeed, store, now: Date.now() + 3600e3, concurrency: 8 });
const d2 = performance.now() - t;
console.log(`PASS2 steady (70% boards 304): ${B} boards in ${(d2 / 1000).toFixed(2)} s; unchanged ${s2.unchanged}, changed ${s2.changed}, closed ${s2.closed}, not_modified ${s2.boards_not_modified}, verified ${s2.verified}`);
const open = store.open(), sample = open.slice(0, 2000);
const rowBytes = sample.reduce((a, p) => a + JSON.stringify(p).length, 0) / sample.length;
console.log(`STORE rows ${store.rows.size} (open ${open.length}); mean row ${Math.round(rowBytes)} B JSON => ${(rowBytes * N / 1048576).toFixed(0)} MB raw at ${N} (gzip/TOAST ~3x smaller); with 1.09M directory-claimed postings ${(rowBytes * 1.09e6 / 1073741824).toFixed(1)} GB raw`);
