// The deployed trainee-file function's dependencies, built in one place so a test can see exactly what index.ts serves with.
// `facts` is the person's CONFIRMED facts (the same source trainee-telegram's job cards use: supabaseConfirmedFacts), so the
// list page's Apply runs the posting screen's knock-outs on real facts instead of holding every posting that needs one.
import { supabaseTapStore } from "../_shared/channel_card_tap.ts";
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
    // A results card that isn't ready: the employer's open questions (asked on the page, saved the way the chat saves them), then
    // the queued applications prepared again, and where each one stands.
    questions: supabaseQuestionStore(admin), reprepare: (userId) => reprepareQueued({ admin, userId, env, fetch: globalThis.fetch.bind(globalThis) }),
    resumeOnFile: (userId) => resumeOnFileReader(admin, userId)(),
    pending: (userId) => pendingRows(admin, userId) };
}
