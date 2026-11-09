// WO-G (architect ruling, R10 fix 12): every card a person is shown carries one review File link per application on it,
// whichever path shows it: the chat's "show my applications" (career_apply_cards.ts cardTurn), the card pushed when a
// preparation they asked for finishes (cloud_prepare.ts: career_apply_card_push_requested_for and the paged push), the
// prepare-ahead card (career_prepare_ahead.ts) and the scheduled card push (career-proactive). Each review File is built by
// code from the prepared payload, the posting's own title and the posting's still-open required questions
// (application_review.ts reviewOf, file_service.ts createReview). A review that cannot be made never changes the card.
import { openQuestionsFor, reviewLinksFor, type ReviewDeps, withLinks } from "./application_review.ts";
import { createFileService, supabaseFileKindStore } from "./file_service.ts";

export type ReviewLinks = (userId: string, preparedIds: string[]) => Promise<string | null>;
// deno-lint-ignore no-explicit-any
export function supabaseReviewDeps(admin: any, userId: string, env: { get(k: string): string | undefined }): ReviewDeps {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data ?? []; };
  const files = createFileService({ store: supabaseFileKindStore(admin), env, now: Date.now });
  return {
    prepared: async (ids) => must(await admin.from("career_apply_prepared").select("id,job_id,payload,payload_hash,card_lines").eq("user_id", userId).in("id", ids), "read the prepared applications"),
    titles: async (jobIds) => new Map<string, string>((must(await admin.from("career_postings").select("job_id,title").in("job_id", jobIds), "read the postings") as { job_id: string; title: string }[]).map((r) => [r.job_id, r.title])),
    open: (jobIds) => openQuestionsFor(admin, userId, jobIds),
    create: async (item) => { const r = await files.createReview!(userId, item); return r.ok ? { url: r.url ?? r.webApp } : null; },
  };
}
// deno-lint-ignore no-explicit-any
export function supabaseReviewLinks(admin: any, env: { get(k: string): string | undefined }): ReviewLinks {
  return (userId, ids) => reviewLinksFor(ids.map((id) => ({ id })), supabaseReviewDeps(admin, userId, env)).catch((e) => {
    console.error("review links:", e instanceof Error ? e.message : String(e));
    return null;
  });
}
// The scheduled and prepare-ahead card push (career_apply_card_push_as), the card text followed by its review links while it
// stays one text. The database still checks that the text carries every card line.
// deno-lint-ignore no-explicit-any
export function supabaseCardPush(admin: any, review?: ReviewLinks) {
  return async (userId: string, ids: string[], text: string): Promise<string | null> => {
    const r = await admin.rpc("career_apply_card_push_as", { p_user: userId, p_ids: ids, p_text: withLinks(text, review ? await review(userId, ids) : null) });
    if (r.error) throw new Error(`push the card: ${r.error.message}`);
    return r.data ?? null;
  };
}
