// trainee-report (RESEARCH ANSWER LAYOUT, 2026-10-28): serves a research report at its stable link. The link is a
// capability for one report and one person (research_report_store.ts reportLink: HMAC with TRAINEE_REPORT_SECRET);
// anything that does not verify, or a report that is not that person's or has expired, is a plain 404. Read-only.
import { type ReportStore, verifyReportLink } from "../_shared/research_report_store.ts";

export interface ReportDeps { env: { get(k: string): string | undefined }; store: () => ReportStore }

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function handleReport(req: Request, d: ReportDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const who = await verifyReportLink(d.env.get("TRAINEE_REPORT_SECRET"), req.url);
  if (!who) return notFound();
  const doc = await d.store().get(who.userId, who.id).catch(() => null);
  if (!doc || !doc.bytes.length) return notFound();
  return new Response(req.method === "HEAD" ? null : doc.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": doc.mime || "text/html; charset=utf-8",
      // The page is static text: no script runs, nothing loads from elsewhere, it is never framed or indexed.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=300",
    },
  });
}
