// The working-set probe for tests/edge/career-ingest-bounded.test.ts (B8): run with --v8-flags=--expose-gc. One run of
// ingestBoards over a 4,600-posting Lever board (~55 MB of JSON, generated as it is read) with the deployed reader options
// and a posting budget; the live heap (after a full gc) is sampled at every store call. Prints one JSON line:
// {bodyMB, baseLiveMB, peakLiveMB, samples, stored}. No network, no database.
import { boardFetchFeed, ingestBoards } from "../../supabase/functions/_shared/career_ingest.ts";
import { leverBody, slimDb, streamed } from "./career-ingest-bounded.test.ts";

// deno-lint-ignore no-explicit-any
const gc = (globalThis as any).gc as () => void;
if (typeof gc !== "function") throw new Error("run with --v8-flags=--expose-gc");
const live = () => { gc(); const m = Deno.memoryUsage(); return (m.heapUsed + m.external) / 1e6; };
let bodyChars = 0;
for (const s of leverBody("boxlunch", 4600, 6000)) bodyChars += s.length;
// One run over the board (live = heap + external buffers, after a full gc) with the given reader options and budget: the peak live heap above the base, and what it stored.
async function measure(opts: { stream?: boolean; bodyHash?: boolean }, postingBudget?: number) {
  const db = slimDb();
  const base = live();
  let peak = base, samples = 0;
  const sample = () => { samples++; peak = Math.max(peak, live()); };
  const watched = { ...db, async known(ids: string[]) { sample(); return await db.known!(ids); }, async getMany(ids: string[]) { sample(); return await db.getMany(ids); },
    async putMany(ps: any[]) { sample(); await db.putMany(ps); sample(); } };
  if (!opts.stream) delete (watched as any).known; // the reader before this fix compared whole rows (getMany)
  // Sampled also as the body arrives (every 16th chunk), so a reader that buffers the body is seen doing it.
  let chunks = 0;
  const f = (async () => streamed(function* () { for (const s of leverBody("boxlunch", 4600, 6000)) { if (++chunks % 400 === 0) sample(); yield s; } })) as unknown as typeof fetch;
  await ingestBoards({ boards: [{ company: "BoxLunch", provider: "lever", board: "boxlunch" }], db: watched, now: Date.UTC(2026, 9, 30), useCursor: false,
    postingBudget, fetchFeed: boardFetchFeed(f, opts) });
  return { growthMB: +(peak - base).toFixed(1), samples, stored: db.rows.size };
}
const budget = await measure({ stream: true, bodyHash: true }, 1000);
const whole = await measure({ stream: true, bodyHash: true });
const before = Deno.args.includes("--before") ? await measure({ bodyHash: true }) : null;
console.log(JSON.stringify({ bodyMB: +(bodyChars / 1e6).toFixed(1), budget, whole, before }));
