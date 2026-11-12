// REAL SETS: the recorded postings (capture.ts) as the rows the product stores and the tailor reads. Each recorded body goes
// through the product's own readers, never a reader written here:
//   Greenhouse, Lever, Ashby, SmartRecruiters  the bundle's normalizers (router_core.career.js CareerJobs.normalize*, the ones
//                                              career_ingest.ts ingestBoards calls), the description stored as ingest stores it
//                                              (posting_text.ts plainText), the pay as ingest reads it (career_ingest.ts boardPay)
//   Workday                                    workday_posting.ts parseWorkdayCxs (the reader the posting check uses)
// Every row also carries the sha256 of its recorded file, checked against sources.json, so a changed input is caught.
// deno-lint-ignore-file no-explicit-any
import { CareerJobs } from "../../../supabase/functions/_shared/router_core.career.js";
import { boardPay } from "../../../supabase/functions/_shared/career_ingest.ts";
import { plainText } from "../../../supabase/functions/_shared/posting_text.ts";
import { parseWorkdayCxs } from "../../../supabase/functions/_shared/workday_posting.ts";

const HERE = new URL(".", import.meta.url).pathname;
export interface PostingRow {
  job_id: string; provider: string; board: string; ats_id: string; title: string; company: string; location: string; url: string;
  description: string; pay: string | null; pays: { place: string; pay: string }[]; file: string; sha256: string; recorded_at: string;
}
async function sha(s: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export async function loadPostings(): Promise<PostingRow[]> {
  const src = JSON.parse(await Deno.readTextFile(`${HERE}sources.json`)).sources as any[];
  const rows: PostingRow[] = [];
  for (const s of src) {
    const body = await Deno.readTextFile(`${HERE}recorded/${s.file}`);
    const got = await sha(body);
    if (got !== s.sha256) throw new Error(`${s.file}: sha256 ${got} is not the recorded ${s.sha256}`);
    const raw = JSON.parse(body);
    const base = { provider: s.provider, board: s.board, ats_id: String(s.id), file: s.file, sha256: got, recorded_at: s.at };
    if (s.provider === "workday") {
      const page = `https://paypal.wd1.myworkdayjobs.com/en-US/jobs${String(s.request).split("/wday/cxs/paypal/jobs")[1] ?? ""}`;
      const p = parseWorkdayCxs(raw, page);
      if (!p) throw new Error(`${s.file}: parseWorkdayCxs read no posting`);
      rows.push({ ...base, job_id: `workday:paypal:${s.id}`, title: p.title, company: p.company ?? "PayPal", location: p.location ?? "", url: p.url, description: p.text, pay: p.pay, pays: p.pays });
      continue;
    }
    const C: any = CareerJobs;
    const n = s.provider === "greenhouse" ? C.normalizeGreenhouse({ jobs: [raw] }, s.board, s.board)
      : s.provider === "lever" ? C.normalizeLever([raw], s.board, s.board)
      : s.provider === "ashby" ? C.normalizeAshby({ jobs: [raw] }, s.board, s.board)
      : C.normalizeSmartRecruiters({ content: [raw] }, s.board, s.board);
    const p = n[0];
    if (!p) throw new Error(`${s.file}: the ${s.provider} normalizer read no posting`);
    // Greenhouse's job answer names the company (company_name); the list the normalizer expects names it as `name`.
    const company = s.provider === "greenhouse" && raw.company_name ? String(raw.company_name) : String(p.company || s.board);
    rows.push({ ...base, job_id: `${s.provider}:${s.board.toLowerCase()}:${s.id}`, title: String(p.title), company, location: String(p.location ?? ""), url: String(p.url ?? ""),
      description: plainText(p.jd_text || ""), pay: boardPay(s.provider, raw), pays: [] });
  }
  return rows;
}
