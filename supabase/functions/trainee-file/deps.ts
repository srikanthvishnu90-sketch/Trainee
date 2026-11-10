// The deployed trainee-file function's dependencies, built in one place so a test can see exactly what index.ts serves with.
// `facts` is the person's CONFIRMED facts (the same source trainee-telegram's job cards use: supabaseConfirmedFacts), so the
// list page's Apply runs the posting screen's knock-outs on real facts instead of holding every posting that needs one.
import { supabaseTapStore } from "../_shared/channel_card_tap.ts";
import { recordsFamilies, supabaseDigestWriter } from "../_shared/file_family_actions.ts";
import { supabaseRecords } from "../_shared/file_family_records.ts";
import { supabaseEventStore } from "../_shared/agent/timeline.ts";
import { supabaseCardStore } from "../_shared/career_apply_cards.ts";
import { supabaseAccountStamp, supabaseConfirmedFacts } from "../_shared/telegram_jobs.ts";
import { supabaseFileStore, supabasePhoneAuth, supabaseSessionStore, supabaseTimeZone, supabaseUserOfTelegram } from "./store.ts";
import { createFileService, supabaseFileKindStore } from "../_shared/file_service.ts";
import { supabaseQuestionStore } from "../_shared/career_apply_questions.ts";
import { pendingRows, reprepareQueued } from "../_shared/career_hosted_prepare.ts";
import { resumeOnFileReader } from "../_shared/career_apply_from_chat.ts";
import type { FileDeps } from "./handler.ts";
import { PHONE_STEP_FLOOR_MS, phonePace } from "../_shared/file_session.ts";
import { supabaseResumeRates } from "../_shared/career_resume_outcomes.ts";
import { reviewRecords } from "../_shared/file_family_review.ts";
import { supabaseReviewDeps } from "../_shared/application_review_links.ts";

// Supabase's edge runtime keeps a promise handed to EdgeRuntime.waitUntil running after the answer is sent.
export const edgeBackground = (work: Promise<unknown>) => {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(work.catch(() => {}));
};

// deno-lint-ignore no-explicit-any
export function buildFileDeps(admin: any, env: FileDeps["env"], now: () => number): FileDeps {
  return { store: supabaseFileStore(admin), cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), now, env, events: supabaseEventStore(admin),
    userOfTelegram: supabaseUserOfTelegram(admin), facts: supabaseConfirmedFacts(admin), account: supabaseAccountStamp(admin), timeZone: supabaseTimeZone(admin),
    // Who may open the page: server-side sessions and phone sign-in (Supabase Auth's SMS code to the account's confirmed phone).
    sessions: supabaseSessionStore(admin), phone: supabasePhoneAuth(admin, { url: env.get("SUPABASE_URL") ?? "", anon: env.get("SUPABASE_ANON_KEY") }),
    // Every phone step answers no sooner than the floor (time never tells whether a number is the account's), and the sign-in
    // text goes out in the background, kept alive by the edge runtime.
    pace: phonePace(PHONE_STEP_FLOOR_MS), background: edgeBackground,
    // The other file kinds. No fileEffects: until a sender is wired, an approved introduction honestly says it was not sent.
    files: createFileService({ store: supabaseFileKindStore(admin), env, now }),
    // Item 6: each File family's records and posts (file_family_serve.ts FamilyRecords). One line per family; each builder adds only its
    // own line (an absent family loads nothing: a ref File shows the C.24 error state, and no post is dispatched).
    familyRecords: {
      ...recordsFamilies({ read: supabaseRecords(admin), digest: supabaseDigestWriter(admin), now, timeZone: supabaseTimeZone(admin) }), // f-s5: F-01 F-02 F-03 F-08 F-13 F-14 F-14n F-15
      // S1: the live Application review, read from the prepared application and its record on every GET (file_family_review.ts).
      "F-09": (() => { const st = supabaseFileStore(admin); return reviewRecords({ review: (u) => supabaseReviewDeps(admin, u, env), current: (u, j) => st.prepared(u, j), appRow: (u, j, url) => st.appRow(u, j, url), cards: supabaseCardStore(admin), account: supabaseAccountStamp(admin), events: supabaseEventStore(admin) }, now); })(),
    },
    // A results card that isn't ready: the employer's open questions (asked on the page, saved the way the chat saves them), then
    // the queued applications prepared again, and where each one stands.
    questions: supabaseQuestionStore(admin), reprepare: (userId) => reprepareQueued({ admin, userId, env, fetch: globalThis.fetch.bind(globalThis) }),
    resumeOnFile: (userId) => resumeOnFileReader(admin, userId)(),
    pending: (userId) => pendingRows(admin, userId),
    // RELEASE 9: the person's own rates by resume version (career_apply_outcomes_by_resume), a read-only section of the page.
    resumeRates: supabaseResumeRates(admin) };
}
