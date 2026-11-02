// The deployed trainee-file function's dependencies, built in one place so a test can see exactly what index.ts serves with.
// `facts` is the person's CONFIRMED facts (the same source trainee-telegram's job cards use: supabaseConfirmedFacts), so the
// list page's Apply runs the posting screen's knock-outs on real facts instead of holding every posting that needs one.
import { supabaseTapStore } from "../_shared/channel_card_tap.ts";
import { supabaseEventStore } from "../_shared/agent/timeline.ts";
import { supabaseCardStore } from "../_shared/career_apply_cards.ts";
import { supabaseAccountStamp, supabaseConfirmedFacts } from "../_shared/telegram_jobs.ts";
import { supabaseFileStore, supabasePhoneAuth, supabaseSessionStore, supabaseTimeZone, supabaseUserOfTelegram } from "./store.ts";
import { createFileService, supabaseFileKindStore } from "../_shared/file_service.ts";
import type { FileDeps } from "./handler.ts";

// deno-lint-ignore no-explicit-any
export function buildFileDeps(admin: any, env: FileDeps["env"], now: () => number): FileDeps {
  return { store: supabaseFileStore(admin), cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), now, env, events: supabaseEventStore(admin),
    userOfTelegram: supabaseUserOfTelegram(admin), facts: supabaseConfirmedFacts(admin), account: supabaseAccountStamp(admin), timeZone: supabaseTimeZone(admin),
    // Who may open the page: server-side sessions and phone sign-in (Supabase Auth's SMS code to the account's confirmed phone).
    sessions: supabaseSessionStore(admin), phone: supabasePhoneAuth(admin, { url: env.get("SUPABASE_URL") ?? "", anon: env.get("SUPABASE_ANON_KEY") }),
    // The other file kinds. No fileEffects: until a sender is wired, an approved introduction honestly says it was not sent.
    files: createFileService({ store: supabaseFileKindStore(admin), env, now }) };
}
