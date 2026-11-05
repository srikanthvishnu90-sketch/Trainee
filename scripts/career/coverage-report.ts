// SEARCH COVERAGE report: for every job-board type ingest reads, the open rows its reader produces from a fixture board,
// what the screens counted and why (stored at ingest, hidden only at search: review 2026-11-05), and what the search sentence "software engineering internship Chicago summer 2027"
// finds. Offline (no network): it proves the READERS and the open/closed/search logic per provider, never a live board.
//   deno run -A scripts/career/coverage-report.ts [--json]
import { boardFetchFeed, ingestBoards, INGEST_PROVIDERS, memoryPostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { searchPostings } from "../../supabase/functions/_shared/career_search.ts";
import { BOARD, FIXTURES, ROWS, TEXT } from "./coverage-fixtures.ts";

export const QUERY = "software engineering internship Chicago summer 2027";
export interface Line { provider: string; mode: string; fixture_rows: number; read: number; open: number; screened: Record<string, number>; url_unknown: number; failures: string[]; search_hits: number; search_ids: string[]; text_visible: boolean }
export async function coverage(now = Date.parse("2026-10-30T12:00:00Z")): Promise<Line[]> {
  const out: Line[] = [];
  for (const stream of [false, true]) for (const provider of INGEST_PROVIDERS) {
    const body = FIXTURES[provider]();
    const fetchFn = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const db = memoryPostingsDb();
    const st = await ingestBoards({ boards: [{ company: "Acme", provider, board: BOARD[provider] ?? "acme" }], fetchFeed: boardFetchFeed(fetchFn, { stream, bodyHash: stream }), db, now, useCursor: false });
    const open = await db.open();
    const hits = searchPostings(open, QUERY, null, 50, { now });
    out.push({ provider, mode: stream ? "stream" : "whole", fixture_rows: ROWS.length, read: st.postings_read ?? st.new, open: open.length, screened: st.screened ?? {}, url_unknown: st.url_unknown ?? 0, failures: st.failures.map((f) => f.error), search_hits: hits.postings.length, search_ids: hits.postings.map((h) => h.job_id), text_visible: TEXT[provider] });
  }
  return out;
}
if (import.meta.main) {
  const lines = await coverage();
  if (Deno.args.includes("--json")) console.log(JSON.stringify(lines, null, 1));
  else {
    console.log(`query: "${QUERY}"   (fixtures: ${ROWS.length} jobs per board; offline, readers only)`);
    console.log("provider".padEnd(16), "mode".padEnd(7), "open", "screened".padEnd(34), "search", "failures");
    for (const l of lines) console.log(l.provider.padEnd(16), l.mode.padEnd(7), String(l.open).padStart(4), JSON.stringify(l.screened).padEnd(34), String(l.search_hits).padStart(6), l.failures.join("; "));
    const zero = lines.filter((l) => l.open === 0).map((l) => `${l.provider}/${l.mode}`);
    console.log(zero.length ? `NO OPEN ROWS: ${zero.join(", ")}` : `every one of ${INGEST_PROVIDERS.length} board types yields open rows from its fixture`);
  }
}
